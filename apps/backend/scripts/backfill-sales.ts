/**
 * Re-runnable REAL Poster historical sales backfill (date-range, per store spot).
 *
 * Walks every day in [--from, --to] (inclusive, Asia/Tashkent), and for each
 * synced store spot fetches that day's transactions from Poster and ingests
 * them through the EXISTING sync path (`ingestTransaction`) — the SAME parsing,
 * tiyin->so'm price (product_price/100), and 2000-01-01 placeholder-date guard
 * the live incremental sync uses. No ingestion logic is duplicated here.
 *
 * Idempotent: `sales.uq_sales_poster_line` (poster_transaction_id, product_id,
 * poster_line_id) + the `stock_movements` partial UNIQUE make re-importing a day
 * a no-op for rows already present. Days already covered by the real
 * incremental sync (04.06+) therefore just no-op.
 *
 * Store spots are read from `locations` (type='store', is_active, poster_spot_id
 * set) — we do NOT hardcode spot ids.
 *
 * Poster rate limits are respected by the client's serial 220ms gate; we add a
 * small extra delay between day calls.
 *
 * Usage:
 *   npm run poster:backfill-sales -w @adia/backend -- --from 2026-05-01 --to 2026-06-06
 *   # --to defaults to today (Asia/Tashkent) when omitted.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config/index.js';
import { createPosterClientFromConfig } from '../src/integrations/poster/client.js';
import { ingestTransaction } from '../src/integrations/poster/salesSync.js';
import type { PosterClient } from '../src/integrations/poster/client.js';
import { query, closePool } from '../src/db/index.js';

const TZ = 'Asia/Tashkent';
/** Extra pause between consecutive day fetches (the client already gates 220ms). */
const DAY_GAP_MS = 150;

type Spot = { spotId: number; name: string };

type DayResult = {
  day: string;
  txFetched: number;
  txWithDate: number;
  linesInserted: number;
  failedLines: number;
};

function parseArg(argv: readonly string[], flag: string): string | undefined {
  const i = argv.findIndex((a) => a === flag);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

function isYmd(s: string | undefined): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Enumerate YYYY-MM-DD days in [from, to] inclusive using Postgres (TZ-correct). */
async function enumerateDays(from: string, to: string): Promise<string[]> {
  const { rows } = await query<{ d: string }>(
    `SELECT to_char(g, 'YYYY-MM-DD') AS d
       FROM generate_series($1::date, $2::date, interval '1 day') g`,
    [from, to],
  );
  return rows.map((r) => r.d);
}

/** Today's date in Asia/Tashkent as YYYY-MM-DD. */
async function todayLocal(): Promise<string> {
  const { rows } = await query<{ d: string }>(
    `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`,
    [TZ],
  );
  return rows[0]!.d;
}

/** Synced store spots (no hardcoded ids). */
async function loadSpots(): Promise<Spot[]> {
  const { rows } = await query<{ poster_spot_id: number; name: string }>(
    `SELECT poster_spot_id, name
       FROM locations
      WHERE type = 'store' AND is_active = TRUE AND poster_spot_id IS NOT NULL
      ORDER BY poster_spot_id`,
  );
  return rows.map((r) => ({ spotId: Number(r.poster_spot_id), name: r.name }));
}

/** Backfill a single day across all spots via the existing ingestion path. */
async function backfillDay(client: PosterClient, day: string, spots: Spot[]): Promise<DayResult> {
  const res: DayResult = { day, txFetched: 0, txWithDate: 0, linesInserted: 0, failedLines: 0 };
  for (const spot of spots) {
    // dash.getTransactions takes date-only YYYY-MM-DD (a time component makes it
    // return zero rows — see salesSync.formatPosterDateTime). Paginate so a busy
    // day is not silently truncated at 1000.
    const list = await client.getTransactions({
      dateFrom: day,
      dateTo: day,
      spotId: spot.spotId,
      num: 1000,
      paginate: true,
    });
    res.txFetched += list.length;
    for (const t of list) {
      const txId = Number(t.transaction_id);
      if (!Number.isInteger(txId) || txId <= 0) continue;
      let full;
      try {
        full = await client.getTransaction(txId);
      } catch (err) {
        console.error(`[backfill]   getTransaction(${txId}) failed:`, (err as Error).message);
        continue;
      }
      if (full === null) continue;
      const out = await ingestTransaction(full);
      if (out.storeFound) res.txWithDate += 1;
      res.linesInserted += out.linesInserted;
      res.failedLines += out.failedLines;
    }
  }
  return res;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.poster.token) {
    console.error('[backfill-sales] POSTER_TOKEN is empty — aborting.');
    process.exit(1);
  }

  const fromArg = parseArg(process.argv, '--from');
  if (!isYmd(fromArg)) {
    console.error('[backfill-sales] --from YYYY-MM-DD is required.');
    process.exit(1);
  }
  let toArg = parseArg(process.argv, '--to');
  if (toArg !== undefined && !isYmd(toArg)) {
    console.error('[backfill-sales] --to must be YYYY-MM-DD.');
    process.exit(1);
  }

  await query(`SET timezone = '${TZ}'`);
  const to = toArg ?? (await todayLocal());
  const days = await enumerateDays(fromArg, to);
  const spots = await loadSpots();
  if (spots.length === 0) {
    console.error('[backfill-sales] no synced store spots found — aborting.');
    process.exit(1);
  }

  console.log(
    `[backfill-sales] range ${fromArg}..${to} (${days.length} days) x spots ` +
      spots.map((s) => `${s.spotId}(${s.name})`).join(', '),
  );

  const client = createPosterClientFromConfig();
  let totalLines = 0;
  let totalFailed = 0;
  let totalTx = 0;
  const emptyDays: string[] = [];

  for (const day of days) {
    const r = await backfillDay(client, day, spots);
    totalLines += r.linesInserted;
    totalFailed += r.failedLines;
    totalTx += r.txFetched;
    if (r.txFetched === 0) emptyDays.push(day);
    console.log(
      `[backfill-sales] ${day}: tx=${r.txFetched} lines_inserted=${r.linesInserted}` +
        (r.failedLines > 0 ? ` failed=${r.failedLines}` : ''),
    );
    await delay(DAY_GAP_MS);
  }

  console.log(
    `[backfill-sales] DONE — ${days.length} days, ${totalTx} tx fetched, ` +
      `${totalLines} new lines inserted, ${totalFailed} failed lines.`,
  );
  if (emptyDays.length > 0) {
    console.log(`[backfill-sales] days Poster returned NO transactions: ${emptyDays.join(', ')}`);
  }
  await closePool();
}

main().catch(async (err: unknown) => {
  console.error('[backfill-sales] failed:', err);
  await closePool().catch(() => undefined);
  process.exit(1);
});
