/**
 * TZ Module 15 — Telegram kassir handler reconciliation reply.
 *
 * Drives `handleCashShiftMessage` end-to-end against a real schema with a
 * stubbed Poster singleton (`setPosterClientForTests`). Asserts:
 *   - a matched submission appends a "holat: Mos" reconciliation block and a
 *     `cash_shift_reconciliation` row is persisted (status matched);
 *   - a discrepancy submission appends "holat: Tafovut" and persists the
 *     discrepancy row + diffs;
 *   - when Poster is unavailable the cashier STILL gets the confirmation
 *     (nakladnoy created) and a `no_poster_data` row — the submission never
 *     breaks (non-fatal guarantee at the handler seam).
 *
 * The handler resolves the user via `loadVoicePrincipal` (telegram_id), so we
 * seed a real `store_manager` with a telegram_id + a store carrying a Poster
 * spot id. No real Grammy Context — a tiny `CashShiftCtxLike` capture adapter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PosterClient,
  setPosterClientForTests,
  resetPosterClientCache,
} from '../src/integrations/poster/client.js';
import { handleCashShiftMessage, type CashShiftCtxLike } from '../src/integrations/telegram/cashShiftHandler.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
  setPosterClientForTests(undefined);
  resetPosterClientCache();
});

beforeEach(async () => {
  await ctx.db.query('DELETE FROM cash_shift_reconciliation');
  await ctx.db.query('DELETE FROM notifications');
  await ctx.db.query('DELETE FROM audit_log');
  await ctx.db.query('DELETE FROM nakladnoy_lines');
  await ctx.db.query('DELETE FROM nakladnoy');
  await ctx.db.query(`UPDATE locations SET manager_user_id = NULL`);
  await ctx.db.query('DELETE FROM users');
  await ctx.db.query('DELETE FROM locations');
  setPosterClientForTests(undefined);
  process.env.POSTER_TOKEN = 'acc:test';
});

/** A store with a Poster spot id. */
async function makeStoreWithSpot(spotId: number, name: string): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO locations (name, type, poster_spot_id) VALUES ($1, 'store', $2) RETURNING id`,
    [name, spotId],
  );
  return Number(rows[0]!.id);
}

/** A store_manager bound to `locationId` with a telegram_id. */
async function makeCashier(locationId: number, telegramId: number): Promise<number> {
  const u = await makeUser(ctx.db, { role: 'store_manager', locationId });
  await ctx.db.query(`UPDATE users SET telegram_id = $1 WHERE id = $2`, [String(telegramId), u.id]);
  return u.id;
}

/** Install a Poster stub whose finance.getCashShifts returns `shifts`. */
function installPoster(shifts: unknown[]): void {
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const m = u.pathname.split('/').pop();
        if (m === 'finance.getCashShifts') {
          return Promise.resolve(new Response(JSON.stringify({ response: shifts }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ response: [] }), { status: 200 }));
      }) as unknown as typeof fetch,
    }),
  );
}

/** Install a Poster stub whose finance calls all HTTP-405 (unavailable). */
function installPosterUnavailable(): void {
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      transientRetries: 0,
      fetcher: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), {
            status: 405,
            statusText: 'Method Not Allowed',
          }),
        )) as unknown as typeof fetch,
    }),
  );
}

/** A capture adapter — records the last reply text. */
function makeCtx(telegramId: number, text: string): {
  ctx: CashShiftCtxLike;
  replies: string[];
} {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      from: { id: telegramId },
      message: { text },
      reply: (t: string) => {
        replies.push(t);
        return Promise.resolve(undefined);
      },
    },
  };
}

describe('handleCashShiftMessage — reconciliation reply', () => {
  it('matched submission appends a "Mos" block and persists a matched row', async () => {
    const store = await makeStoreWithSpot(901, 'Bot Store A');
    const tgId = 555001;
    await makeCashier(store, tgId);
    // Poster matches the cashier exactly: cash 3 000 000, card 2 000 000, expense 500 000.
    installPoster([
      {
        cash_shift_id: '9101',
        spot_id: 901,
        amount_sell_cash: 300_000_000,
        amount_sell_card: 200_000_000,
        amount_debit: 50_000_000,
      },
    ]);

    const { ctx: c, replies } = makeCtx(
      tgId,
      'rasxod 500 000, qoldim 5 000 000 (kartadan 2 000 000), itogo savdo',
    );
    const result = await handleCashShiftMessage(c);

    expect(result.handled).toBe(true);
    expect(result.nakladnoyId).not.toBeNull();
    expect(result.reconciliationStatus).toBe('matched');

    const reply = replies.join('\n');
    expect(reply).toContain('Smena topshirildi');
    expect(reply).toContain('Poster solishtiruv');
    expect(reply).toContain('Mos');

    const { rows } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM cash_shift_reconciliation WHERE nakladnoy_id = $1`,
      [result.nakladnoyId],
    );
    expect(rows[0]?.status).toBe('matched');
  });

  it('discrepancy submission appends a "Tafovut" block and persists diffs', async () => {
    const store = await makeStoreWithSpot(902, 'Bot Store B');
    const tgId = 555002;
    await makeCashier(store, tgId);
    // Poster cash is 1 000 000 LESS than the cashier's naqd qoldiq (3 000 000).
    installPoster([
      {
        cash_shift_id: '9201',
        spot_id: 902,
        amount_sell_cash: 200_000_000, // 2 000 000 so'm
        amount_sell_card: 200_000_000, // 2 000 000 so'm
        amount_debit: 50_000_000, // 500 000 so'm
      },
    ]);

    const { ctx: c, replies } = makeCtx(
      tgId,
      'rasxod 500 000, qoldim 5 000 000 (kartadan 2 000 000)',
    );
    const result = await handleCashShiftMessage(c);
    expect(result.reconciliationStatus).toBe('discrepancy');
    expect(replies.join('\n')).toContain('Tafovut');

    const { rows } = await ctx.db.query<{ status: string; cash_diff: string | null }>(
      `SELECT status, cash_diff FROM cash_shift_reconciliation WHERE nakladnoy_id = $1`,
      [result.nakladnoyId],
    );
    expect(rows[0]?.status).toBe('discrepancy');
    expect(Number(rows[0]?.cash_diff)).toBe(1_000_000);
  });

  it('NON-FATAL: Poster unavailable still confirms the submission (no_poster_data)', async () => {
    const store = await makeStoreWithSpot(903, 'Bot Store C');
    const tgId = 555003;
    await makeCashier(store, tgId);
    installPosterUnavailable();

    const { ctx: c, replies } = makeCtx(
      tgId,
      'rasxod 500 000, qoldim 5 000 000 (kartadan 2 000 000)',
    );
    const result = await handleCashShiftMessage(c);

    // The submission still succeeds — the nakladnoy exists.
    expect(result.handled).toBe(true);
    expect(result.nakladnoyId).not.toBeNull();
    expect(result.reconciliationStatus).toBe('no_poster_data');
    expect(replies.join('\n')).toContain('Smena topshirildi');

    const { rows } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM cash_shift_reconciliation WHERE nakladnoy_id = $1`,
      [result.nakladnoyId],
    );
    expect(rows[0]?.status).toBe('no_poster_data');
  });
});
