/**
 * B1 + B3 (telegram-bot-tz) — voiceHandler with the Gemini-audio PRIMARY STT
 * path and the cross-department `request` action.
 *
 * We inject a fake `transcribeAndParse` dep (the one-call audio path). The
 * handler must:
 *   - use it as primary (Yandex `recognize` is NOT called);
 *   - turn a `request` intent into a replenishment request to the topology
 *     parent (no confirm button) + status `executed`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import os from 'node:os';

import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import {
  handleVoiceMessage,
  type VoiceCtxLike,
  type VoiceHandlerDeps,
} from '../src/integrations/telegram/voiceHandler.js';

let ctx: TestContext;
let centralId: number;
let storeId: number;
let productId: number;
let storeManager: number;
let centralManager: number;
let tgId: number;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  centralId = await makeLocation(ctx.db, { type: 'central_warehouse' });
  storeId = await makeLocation(ctx.db, { type: 'store', parentId: centralId });
  productId = await makeProduct(ctx.db, { name: 'НАПОЛЕОН', unit: 'pcs' });
  await setStock(ctx.db, { locationId: storeId, productId, qty: 1, minLevel: 0, maxLevel: 0 });

  const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: storeId });
  storeManager = sm.id;
  const cwm = await makeUser(ctx.db, {
    role: 'central_warehouse_manager',
    locationId: centralId,
  });
  centralManager = cwm.id;
  await ctx.db.query(`UPDATE locations SET manager_user_id = $1 WHERE id = $2`, [
    centralManager,
    centralId,
  ]);
  await ctx.db.query(`UPDATE locations SET manager_user_id = $1 WHERE id = $2`, [
    storeManager,
    storeId,
  ]);
  tgId = 800000 + storeManager;
  await ctx.db.query(`UPDATE users SET telegram_id = $1 WHERE id = $2`, [
    String(tgId),
    storeManager,
  ]);
});

function fakeCtx(): VoiceCtxLike & {
  replies: Array<{ text: string; opts?: Record<string, unknown> }>;
} {
  const replies: Array<{ text: string; opts?: Record<string, unknown> }> = [];
  return {
    from: { id: tgId },
    message: { message_id: 9100, voice: { file_id: 'fid', duration: 3, file_size: 999 } },
    replies,
    async reply(text: string, opts?: Record<string, unknown>) {
      replies.push({ text, opts });
      return undefined;
    },
  };
}

describe('handleVoiceMessage — Gemini audio primary (B1) + request (B3)', () => {
  it('uses transcribeAndParse and creates a cross-dept request, not a stock movement', async () => {
    let yandexCalled = false;
    const deps: VoiceHandlerDeps = {
      tmpDir: os.tmpdir(),
      downloadVoice: async () => Buffer.from('OggS-audio'),
      transcribeAndParse: async (input) => {
        // The catalog should have been fetched for the store location.
        expect(Array.isArray(input.catalogNames)).toBe(true);
        return {
          transcript: 'menga yigirmata napoleon kerak',
          intents: [
            {
              action: 'request',
              product_name: 'НАПОЛЕОН',
              qty: 20,
              unit: 'pcs',
              from_location_hint: null,
              to_location_hint: null,
            },
          ],
          empty_reason: null,
        };
      },
      recognize: async () => {
        yandexCalled = true;
        return { text: 'should-not-be-used', elapsedMs: 1 };
      },
      parseIntent: async () => ({ intents: [], empty_reason: 'no_intents' }),
    };

    const c = fakeCtx();
    const result = await handleVoiceMessage(c, deps);

    // Primary path used; Yandex fallback NOT called.
    expect(yandexCalled).toBe(false);
    expect(result.status).toBe('executed');
    expect(result.stagedActionIds).toHaveLength(0);

    // A replenishment request was created from the store to the central wh.
    const { rows } = await ctx.db.query<{
      id: string;
      requester_location_id: string;
      qty_needed: string;
      status: string;
    }>(
      `SELECT id, requester_location_id, qty_needed, status
         FROM replenishment_requests
        WHERE requester_location_id = $1 AND product_id = $2`,
      [storeId, productId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.qty_needed)).toBe(20);

    // No assistant_action (it is a request, not a confirm-button movement).
    const { rows: acts } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM assistant_actions WHERE user_id = $1`,
      [storeManager],
    );
    expect(Number(acts[0]?.n)).toBe(0);

    // The target manager was notified with xreq buttons.
    const reqId = Number(rows[0]?.id);
    const { rows: notif } = await ctx.db.query<{
      inline_callback: { buttons: { data: string }[][] } | null;
    }>(
      `SELECT inline_callback FROM notifications
        WHERE recipient_user_id = $1 ORDER BY id DESC LIMIT 1`,
      [centralManager],
    );
    const data = (notif[0]?.inline_callback?.buttons ?? []).flat().map((b) => b.data);
    expect(data).toContain(`xreq:accept:${reqId}`);

    // The bot echoed the transcript.
    expect(c.replies[0]?.text).toContain('napoleon');
  });

  it('falls back to Yandex when the Gemini path throws', async () => {
    let yandexCalled = false;
    const deps: VoiceHandlerDeps = {
      tmpDir: os.tmpdir(),
      downloadVoice: async () => Buffer.from('OggS-audio'),
      transcribeAndParse: async () => {
        throw new Error('vertex audio transport error');
      },
      recognize: async () => {
        yandexCalled = true;
        return { text: 'omborga besh dona napoleon keldi', elapsedMs: 5 };
      },
      parseIntent: async () => ({
        intents: [
          {
            action: 'adjust_in',
            product_name: 'НАПОЛЕОН',
            qty: 5,
            unit: 'pcs',
            from_location_hint: null,
            to_location_hint: null,
          },
        ],
        empty_reason: null,
      }),
    };

    const c = fakeCtx();
    const result = await handleVoiceMessage(c, deps);
    expect(yandexCalled).toBe(true);
    // adjust_in → a staged confirm action (the legacy movement path).
    expect(result.status).toBe('actions_pending');
    expect(result.stagedActionIds.length).toBeGreaterThan(0);
  });
});
