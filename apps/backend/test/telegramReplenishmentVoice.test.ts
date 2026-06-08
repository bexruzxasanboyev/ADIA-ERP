/**
 * VOICE → replenishment-request — Telegram bot handler tests.
 *
 * Covers `handleReplenishmentVoice` (the `message:voice` handler) end-to-end:
 *
 *   1. A store manager's voice ("menga 10 ta napoleon kerak") → the bot stages
 *      a `create_replenishment_request` pending action and replies with a
 *      ✅ Tasdiqlash / ❌ Bekor qilish inline keyboard.
 *   2. The Tasdiqlash callback (`apprv:act:<id>`) → the real request is created
 *      (reuses the EXISTING dispatch → `confirmAction` path).
 *   3. The Bekor callback (`rej:act:<id>`) → the action is rejected, no request.
 *   4. An UNLINKED sender → a clear "akkauntingiz ulanmagan" reply, no staging.
 *   5. No request detected (assistant just answered) → the reply is relayed,
 *      no keyboard.
 *   6. A failed download → a graceful reply, no crash.
 *
 * The transcription + Vertex text model are injected as fakes (the SAME pattern
 * as `services.voiceAssistant.test.ts`) so the suite is hermetic, but the
 * pending-action staging and the confirm path run against the real DB — so the
 * test proves the request really lands.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import type { GenerateContentResponse } from '@google/genai';

import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import type { VertexClient } from '../src/integrations/vertex/client.js';
import type { TranscribeAndParseResult } from '../src/integrations/vertex/parseVoiceAudio.js';
import { runVoiceAssistant } from '../src/services/voiceAssistant.js';
import {
  handleReplenishmentVoice,
  __forTesting,
  type ReplenishVoiceCtxLike,
  type ReplenishVoiceDeps,
} from '../src/integrations/telegram/replenishmentVoiceHandler.js';
import {
  dispatchCallback,
  parseCallbackData,
  type CallbackPrincipal,
} from '../src/integrations/telegram/dispatch.js';

let ctx: TestContext;
let store: number;
let napoleon: number;
let smId: number;
let tgId: number;
let principal: CallbackPrincipal;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  store = await makeLocation(ctx.db, {
    type: 'store',
    name: `Kukcha ${Math.random().toString(36).slice(2, 6)}`,
  });
  napoleon = await makeProduct(ctx.db, { name: 'Г/П НАПОЛЕОН', type: 'finished' });
  await setStock(ctx.db, {
    locationId: store,
    productId: napoleon,
    qty: 2,
    minLevel: 5,
    maxLevel: 30,
  });
  const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
  smId = sm.id;
  tgId = 200000 + smId;
  await ctx.db.query(`UPDATE users SET telegram_id = $1 WHERE id = $2`, [
    String(tgId),
    smId,
  ]);
  principal = { userId: smId, role: 'store_manager', locationId: store };
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const AUDIO = Buffer.from('OggS-fake-voice-bytes');

function textResponse(text: string): GenerateContentResponse {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }],
  } as unknown as GenerateContentResponse;
}

function callResponse(
  name: string,
  args: Record<string, unknown>,
): GenerateContentResponse {
  return {
    candidates: [
      { content: { role: 'model', parts: [{ functionCall: { name, args } }] }, index: 0 },
    ],
  } as unknown as GenerateContentResponse;
}

function makeTextClient(queue: GenerateContentResponse[]): VertexClient {
  return {
    enabled: true,
    async generate(): Promise<GenerateContentResponse> {
      const next = queue.shift();
      if (next === undefined) throw new Error('text queue empty');
      return next;
    },
  } as unknown as VertexClient;
}

const fixedTranscriber = (transcript: string) =>
  async (): Promise<TranscribeAndParseResult> => ({
    transcript,
    intents: [],
    empty_reason: transcript === '' ? 'empty_transcript' : null,
  });

/** A Telegram voice ctx recorder. */
function fakeCtx(opts?: { tgId?: number }): ReplenishVoiceCtxLike & {
  replies: Array<{ text: string; opts?: Record<string, unknown> }>;
} {
  const replies: Array<{ text: string; opts?: Record<string, unknown> }> = [];
  return {
    from: { id: opts?.tgId ?? tgId },
    message: {
      message_id: 5001,
      voice: { file_id: 'voice_file_abc', duration: 4, file_size: 9000 },
    },
    replies,
    async reply(text: string, replyOpts?: Record<string, unknown>) {
      replies.push({ text, opts: replyOpts });
      return undefined;
    },
  };
}

/**
 * Build handler deps that route `runVoice` through the REAL `runVoiceAssistant`
 * with injected fakes — so a real pending `assistant_actions` row is staged and
 * the returned `action_id` is genuine (the confirm path can then run on it).
 */
function makeDeps(opts: {
  transcript: string;
  vertexQueue: GenerateContentResponse[];
  downloadThrows?: boolean;
}): ReplenishVoiceDeps {
  return {
    downloadVoice: async () => {
      if (opts.downloadThrows === true) throw new Error('download failed');
      return AUDIO;
    },
    loadPrincipal: async (telegramId) => {
      // Mirror loadVoicePrincipal: resolve only the seeded telegram id.
      if (String(telegramId) !== String(tgId)) return null;
      return {
        userId: smId,
        role: 'store_manager',
        locationId: store,
        locationIds: [store],
        activeLocationId: store,
      };
    },
    runVoice: ({ audio, principal: p }) =>
      runVoiceAssistant({
        audio,
        principal: p,
        transcribe: fixedTranscriber(opts.transcript),
        client: makeTextClient(opts.vertexQueue),
      }),
  };
}

// ---------------------------------------------------------------------------
// 1 + 2. voice → staged → confirm creates the request
// ---------------------------------------------------------------------------

describe('handleReplenishmentVoice — staged + confirm', () => {
  it('stages create_replenishment_request and shows a Tasdiqlash/Bekor keyboard', async () => {
    const ctxF = fakeCtx();
    const out = await handleReplenishmentVoice(
      ctxF,
      makeDeps({
        transcript: 'menga 10 ta napoleon kerak',
        vertexQueue: [
          callResponse('create_replenishment_request', {
            product_id: napoleon,
            requester_location_id: store,
            qty_needed: 10,
          }),
          textResponse('Tayyorladim. Tasdiqlaysizmi?'),
        ],
      }),
    );

    expect(out.status).toBe('staged');
    expect(out.actionId).toEqual(expect.any(Number));

    // The pending row really landed.
    const { rows } = await ctx.db.query<{ status: string; tool_name: string }>(
      `SELECT status, tool_name FROM assistant_actions WHERE id = $1`,
      [out.actionId],
    );
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.tool_name).toBe('create_replenishment_request');

    // The bot replied with the summary + a confirm keyboard.
    expect(ctxF.replies).toHaveLength(1);
    const reply = ctxF.replies[0]!;
    expect(reply.text).toContain('menga 10 ta napoleon kerak'); // transcript echoed
    expect(reply.text).toContain('НАПОЛЕОН'); // human summary
    const keyboard = (
      reply.opts as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data: string }>> } }
    )?.reply_markup?.inline_keyboard;
    expect(keyboard).toBeDefined();
    const datas = keyboard!.flat().map((b) => b.callback_data);
    expect(datas).toContain(`apprv:act:${out.actionId}`);
    expect(datas).toContain(`rej:act:${out.actionId}`);
  });

  it('Tasdiqlash callback creates the replenishment_request', async () => {
    const ctxF = fakeCtx();
    const out = await handleReplenishmentVoice(
      ctxF,
      makeDeps({
        transcript: 'menga 10 ta napoleon kerak',
        vertexQueue: [
          callResponse('create_replenishment_request', {
            product_id: napoleon,
            requester_location_id: store,
            qty_needed: 10,
          }),
          textResponse('Tasdiqlaysizmi?'),
        ],
      }),
    );
    expect(out.status).toBe('staged');

    // Press ✅ Tasdiqlash → the existing dispatch path confirms the action.
    const parsed = parseCallbackData(`apprv:act:${out.actionId}`);
    expect(parsed).not.toBeNull();
    const outcome = await dispatchCallback(parsed!, principal);
    expect(outcome.kind).toBe('ok');

    // The action is executed and a real request now exists for the store.
    const { rows: act } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM assistant_actions WHERE id = $1`,
      [out.actionId],
    );
    expect(act[0]?.status).toBe('executed');

    const { rows: req } = await ctx.db.query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM replenishment_requests
        WHERE requester_location_id = $1 AND product_id = $2`,
      [store, napoleon],
    );
    expect(Number(req[0]?.cnt ?? '0')).toBe(1);
  });

  it('Bekor qilish callback rejects the action — no request created', async () => {
    const ctxF = fakeCtx();
    const out = await handleReplenishmentVoice(
      ctxF,
      makeDeps({
        transcript: 'menga 10 ta napoleon kerak',
        vertexQueue: [
          callResponse('create_replenishment_request', {
            product_id: napoleon,
            requester_location_id: store,
            qty_needed: 10,
          }),
          textResponse('Tasdiqlaysizmi?'),
        ],
      }),
    );
    expect(out.status).toBe('staged');

    const parsed = parseCallbackData(`rej:act:${out.actionId}`);
    const outcome = await dispatchCallback(parsed!, principal);
    expect(outcome.kind).toBe('ok');

    const { rows: act } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM assistant_actions WHERE id = $1`,
      [out.actionId],
    );
    expect(act[0]?.status).toBe('rejected');

    const { rows: req } = await ctx.db.query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM replenishment_requests
        WHERE requester_location_id = $1 AND product_id = $2`,
      [store, napoleon],
    );
    expect(Number(req[0]?.cnt ?? '0')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Unlinked sender
// ---------------------------------------------------------------------------

describe('handleReplenishmentVoice — unlinked sender', () => {
  it('replies with a clear "akkauntingiz ulanmagan" message and stages nothing', async () => {
    const ctxF = fakeCtx({ tgId: 999999 }); // not the seeded telegram id
    const out = await handleReplenishmentVoice(
      ctxF,
      makeDeps({ transcript: 'menga 10 ta napoleon kerak', vertexQueue: [] }),
    );

    expect(out.status).toBe('unlinked');
    expect(out.actionId).toBeNull();
    expect(ctxF.replies).toHaveLength(1);
    expect(ctxF.replies[0]?.text).toBe(__forTesting.UNLINKED_REPLY);
    expect(ctxF.replies[0]?.text).toContain('ulanmagan');

    // No pending action was created.
    const { rows } = await ctx.db.query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM assistant_actions WHERE user_id = $1`,
      [smId],
    );
    expect(Number(rows[0]?.cnt ?? '0')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. No request detected — relay the assistant reply, no keyboard
// ---------------------------------------------------------------------------

describe('handleReplenishmentVoice — no request', () => {
  it('relays the assistant text with no confirm keyboard when nothing is staged', async () => {
    const ctxF = fakeCtx();
    const out = await handleReplenishmentVoice(
      ctxF,
      makeDeps({
        transcript: 'salom',
        vertexQueue: [textResponse('Assalomu alaykum! Sizga qanday yordam bera olaman?')],
      }),
    );

    expect(out.status).toBe('no_action');
    expect(out.actionId).toBeNull();
    expect(ctxF.replies).toHaveLength(1);
    expect(ctxF.replies[0]?.opts).toBeUndefined(); // no keyboard
    expect(ctxF.replies[0]?.text).toContain('Assalomu alaykum');
  });
});

// ---------------------------------------------------------------------------
// 5. Download failure
// ---------------------------------------------------------------------------

describe('handleReplenishmentVoice — download failure', () => {
  it('replies gracefully and does not throw when the audio cannot be fetched', async () => {
    const ctxF = fakeCtx();
    const out = await handleReplenishmentVoice(
      ctxF,
      makeDeps({
        transcript: 'menga 10 ta napoleon kerak',
        vertexQueue: [],
        downloadThrows: true,
      }),
    );

    expect(out.status).toBe('download_failed');
    expect(out.actionId).toBeNull();
    expect(ctxF.replies).toHaveLength(1);
    expect(ctxF.replies[0]?.text).toContain("yuklab bo'lmadi");
  });
});
