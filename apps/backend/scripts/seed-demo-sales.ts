/**
 * One-off demo-sales backfill — replaces the sparse fake SEED `sales` rows with
 * realistic demo sales so the 30-day dashboard charts (main + store dashboard,
 * both read `sales`) are smooth and match the REAL Poster-synced data's scale.
 *
 * This is a DATA operation, not app code. It:
 *   1. DELETEs the old SEED rows (created_at = the single fake batch timestamp).
 *   2. DERIVEs an authentic catalogue from REAL data (sold_at >= 2026-06-04):
 *      product pool with real avg unit price + real line-frequency weight, the
 *      real per-product qty samples, the real store share, and the real hourly
 *      receipt curve.
 *   3. GENERATEs demo sales for every day 2026-04-29 .. 2026-06-03 inclusive
 *      (Asia/Tashkent), filling the whole pre-real window (incl. the 28.05-03.06
 *      gap) at the real scale.
 *   4. Inserts everything in ONE transaction.
 *
 * Synthetic receipts use NEGATIVE poster_transaction_id (start -1, decrement)
 * so they can never collide with real positive Poster ids and are trivially
 * identifiable/removable:
 *     DELETE FROM sales WHERE poster_transaction_id < 0;
 *
 * Re-runnable: it first deletes any prior synthetic rows (poster_transaction_id
 * < 0) and the SEED batch, then regenerates. Math.random is fine here (standalone
 * script, not the workflow engine).
 *
 * Usage:  npx tsx scripts/seed-demo-sales.ts        (from apps/backend)
 *   or:   npm run seed:demo-sales -w @adia/backend   (if wired into package.json)
 */
import { query, withTransaction, closePool } from '../src/db/index.js';

const SEED_BATCH_CREATED_AT = '2026-05-28 11:46:37.809825+05';
const REAL_CUTOFF = '2026-06-04'; // sold_at >= this is REAL — never touched.
const FIRST_DAY = '2026-04-29';
const LAST_DAY = '2026-06-03'; // inclusive
const TZ = 'Asia/Tashkent';

// Per-day receipt count band (mirrors real 151-189).
const MIN_RECEIPTS = 150;
const MAX_RECEIPTS = 190;

type ProductSample = {
  product_id: number;
  price: number; // real avg unit price (so'm)
};

/** Weighted pick from a cumulative-weight table. */
function weightedPick<T>(items: T[], cumWeights: number[], total: number): T {
  const r = Math.random() * total;
  // binary search the cumulative array
  let lo = 0;
  let hi = cumWeights.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumWeights[mid]! < r) lo = mid + 1;
    else hi = mid;
  }
  return items[lo]!;
}

function randInt(minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(Math.random() * (maxInclusive - minInclusive + 1));
}

async function main(): Promise<void> {
  console.log('[seed-demo-sales] starting...');

  // ---- 0. Pin session timezone for all date math in this run. ----
  await query(`SET timezone = '${TZ}'`);

  // ---- 1. Verify + capture what we will delete. ----
  const seedCount = await query<{ c: number }>(
    `SELECT count(*)::int AS c FROM sales WHERE created_at = $1`,
    [SEED_BATCH_CREATED_AT],
  );
  const seedRows = seedCount.rows[0]?.c ?? 0;
  console.log(`[seed-demo-sales] SEED batch rows (created_at=${SEED_BATCH_CREATED_AT}): ${seedRows}`);

  const priorSynthetic = await query<{ c: number }>(
    `SELECT count(*)::int AS c FROM sales WHERE poster_transaction_id < 0`,
  );
  const priorSyn = priorSynthetic.rows[0]?.c ?? 0;
  if (priorSyn > 0) {
    console.log(`[seed-demo-sales] prior synthetic rows (poster_transaction_id<0): ${priorSyn} (will be replaced)`);
  }

  // ---- 2. Derive the catalogue from REAL data. ----
  // Product pool: real avg unit price + line-frequency weight (popularity).
  const pool = await query<{ product_id: number; avg_price: number; line_weight: number }>(
    `SELECT product_id,
            round(avg(price))::numeric AS avg_price,
            count(*)::int             AS line_weight
       FROM sales
      WHERE sold_at >= $1
      GROUP BY product_id
      HAVING round(avg(price)) > 0
      ORDER BY line_weight DESC`,
    [REAL_CUTOFF],
  );
  if (pool.rows.length === 0) {
    throw new Error('No REAL data found (sold_at >= ' + REAL_CUTOFF + '); cannot derive catalogue.');
  }

  // Per-product real qty samples — to reproduce the bimodal qty distribution
  // (many qty=1, some 2-5, a heavy bulk tail) authentically per product.
  const qtyRows = await query<{ product_id: number; qty: number }>(
    `SELECT product_id, qty FROM sales WHERE sold_at >= $1`,
    [REAL_CUTOFF],
  );
  const qtyByProduct = new Map<number, number[]>();
  for (const r of qtyRows.rows) {
    const arr = qtyByProduct.get(r.product_id) ?? [];
    arr.push(Number(r.qty));
    qtyByProduct.set(r.product_id, arr);
  }

  const products: ProductSample[] = pool.rows.map((r) => ({
    product_id: r.product_id,
    price: Number(r.avg_price),
  }));
  // Cumulative weight table by real line popularity.
  const cum: number[] = [];
  let running = 0;
  for (const r of pool.rows) {
    running += r.line_weight;
    cum.push(running);
  }
  const totalWeight = running;
  console.log(`[seed-demo-sales] derived ${products.length} products from real data`);

  // Store ids + their real receipt share.
  const storeRows = await query<{ store_id: number; receipts: number }>(
    `SELECT store_id, count(DISTINCT poster_transaction_id)::int AS receipts
       FROM sales WHERE sold_at >= $1 GROUP BY store_id ORDER BY receipts DESC`,
    [REAL_CUTOFF],
  );
  if (storeRows.rows.length === 0) throw new Error('No real store ids found.');
  const storeCum: number[] = [];
  let storeRunning = 0;
  for (const s of storeRows.rows) {
    storeRunning += s.receipts;
    storeCum.push(storeRunning);
  }
  const storeTotal = storeRunning;
  const storeIds = storeRows.rows.map((s) => s.store_id);
  console.log(`[seed-demo-sales] stores: ${storeRows.rows.map((s) => `${s.store_id}(${s.receipts})`).join(', ')}`);

  // Real hourly receipt curve (08..22 local) -> weighted hour picker.
  const hourRows = await query<{ hr: number; receipts: number }>(
    `SELECT EXTRACT(hour FROM sold_at AT TIME ZONE $2)::int AS hr,
            count(DISTINCT poster_transaction_id)::int      AS receipts
       FROM sales WHERE sold_at >= $1
      GROUP BY 1 ORDER BY 1`,
    [REAL_CUTOFF, TZ],
  );
  // Clamp to the 08..22 business window per the brief.
  const hours: number[] = [];
  const hourWeights: number[] = [];
  for (const h of hourRows.rows) {
    if (h.hr >= 8 && h.hr <= 22) {
      hours.push(h.hr);
      hourWeights.push(h.receipts);
    }
  }
  const hourCum: number[] = [];
  let hourRunning = 0;
  for (const w of hourWeights) {
    hourRunning += w;
    hourCum.push(hourRunning);
  }
  const hourTotal = hourRunning || 1;

  // Real lines-per-receipt band (avg ~2.5; brief asks 2-4).
  const LINES_MIN = 2;
  const LINES_MAX = 4;

  // ---- 3. Build all rows in memory. ----
  type Row = {
    store_id: number;
    product_id: number;
    qty: number;
    price: number;
    localStamp: string; // local wall-clock 'YYYY-MM-DD HH:MM:SS' (Asia/Tashkent)
    txn_id: number;
    line_id: number;
  };
  const rows: Row[] = [];
  let nextTxnId = -1;

  // Enumerate days FIRST_DAY..LAST_DAY inclusive in Asia/Tashkent.
  const dayList = await query<{ d: string }>(
    `SELECT to_char(g, 'YYYY-MM-DD') AS d
       FROM generate_series($1::date, $2::date, interval '1 day') g`,
    [FIRST_DAY, LAST_DAY],
  );

  for (const dayRow of dayList.rows) {
    const day = dayRow.d; // 'YYYY-MM-DD' local
    const receiptCount = randInt(MIN_RECEIPTS, MAX_RECEIPTS);
    for (let r = 0; r < receiptCount; r++) {
      const txnId = nextTxnId--;
      const storeId = weightedPick(storeIds, storeCum, storeTotal);
      const hour = weightedPick(hours, hourCum, hourTotal);
      const minute = randInt(0, 59);
      const second = randInt(0, 59);
      // Build a TIMESTAMPTZ from local wall-clock components below in SQL via
      // a parameter string interpreted in the session timezone (Asia/Tashkent).
      const hh = String(hour).padStart(2, '0');
      const mm = String(minute).padStart(2, '0');
      const ss = String(second).padStart(2, '0');
      const localStamp = `${day} ${hh}:${mm}:${ss}`;

      const nLines = randInt(LINES_MIN, LINES_MAX);
      const usedProducts = new Set<number>();
      let lineNo = 0;
      let attempts = 0;
      while (lineNo < nLines && attempts < nLines * 6) {
        attempts++;
        const prod = weightedPick(products, cum, totalWeight);
        if (usedProducts.has(prod.product_id)) continue; // distinct products per receipt
        usedProducts.add(prod.product_id);
        lineNo++;
        // Draw a realistic qty by sampling this product's REAL qty observations
        // (reproduces the qty=1 / 2-5 / bulk-tail shape authentically).
        const samples = qtyByProduct.get(prod.product_id);
        let qty: number;
        if (samples && samples.length > 0) {
          qty = samples[randInt(0, samples.length - 1)]!;
        } else {
          qty = randInt(1, 5);
        }
        if (!(qty > 0)) qty = 1;
        rows.push({
          store_id: storeId,
          product_id: prod.product_id,
          qty,
          price: prod.price,
          localStamp,
          txn_id: txnId,
          line_id: lineNo,
        });
      }
    }
  }

  console.log(`[seed-demo-sales] generated ${rows.length} demo line rows across ${dayList.rows.length} days`);

  // ---- 4. One transaction: delete old, insert new. ----
  await withTransaction(async (tx) => {
    // safety: NEVER touch real rows.
    const delSeed = await tx.query(
      `DELETE FROM sales WHERE created_at = $1 AND sold_at < $2`,
      [SEED_BATCH_CREATED_AT, REAL_CUTOFF],
    );
    const delSyn = await tx.query(
      `DELETE FROM sales WHERE poster_transaction_id < 0 AND sold_at < $1`,
      [REAL_CUTOFF],
    );
    console.log(`[seed-demo-sales]   deleted ${delSeed.rowCount} SEED rows + ${delSyn.rowCount} prior synthetic rows`);

    // Bulk insert in chunks. sold_at is built from the local wall-clock string
    // in the session timezone via `($k)::timestamp AT TIME ZONE 'Asia/Tashkent'`.
    const CHUNK = 500;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values: string[] = [];
      const params: (string | number)[] = [];
      let p = 0;
      for (const row of chunk) {
        const a = ++p; // store_id
        const b = ++p; // product_id
        const c = ++p; // qty
        const d = ++p; // price
        const e = ++p; // localStamp
        const f = ++p; // txn_id
        const g = ++p; // line_id
        values.push(
          `($${a}, $${b}, $${c}, $${d}, ($${e})::timestamp AT TIME ZONE '${TZ}', $${f}, $${g})`,
        );
        params.push(row.store_id, row.product_id, row.qty, row.price, row.localStamp, row.txn_id, row.line_id);
      }
      const res = await tx.query(
        `INSERT INTO sales (store_id, product_id, qty, price, sold_at, poster_transaction_id, poster_line_id)
         VALUES ${values.join(', ')}`,
        params,
      );
      inserted += res.rowCount;
    }
    console.log(`[seed-demo-sales]   inserted ${inserted} demo rows`);
  });

  console.log('[seed-demo-sales] done.');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('[seed-demo-sales] failed:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
