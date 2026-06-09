/**
 * Voice → AI-assistant-action service tests (`runVoiceAssistant`).
 *
 * The service glues transcription (`parseVoiceAudio`) to the assistant query
 * flow (`runAssistantQuery`). Both are injected as fakes so the suite is
 * hermetic (no GCP):
 *   - `transcribe` returns a canned transcript;
 *   - `client` is the SAME fake `VertexClient` shape `runAssistantQuery`
 *     already accepts (a queue of `GenerateContentResponse`).
 *
 * Invariants asserted:
 *   1. A spoken "menga 10 ta napoleon kerak" → a staged
 *      `create_replenishment_request` pending action for the caller's OWN
 *      location, with `transcript` echoed back.
 *   2. RBAC — a store manager can only stage a request for their own store;
 *      a foreign requester_location_id is denied (no pending_action).
 *   3. Empty / blank / unintelligible audio → a graceful "tushunmadim" reply
 *      with no session, no pending action, and NO Vertex text round-trip.
 *   4. A transcription transport failure degrades the same graceful way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import type { GenerateContentResponse } from '@google/genai';
import type { VertexClient } from '../src/integrations/vertex/client.js';
import type { TranscribeAndParseResult } from '../src/integrations/vertex/parseVoiceAudio.js';
import {
  runVoiceAssistant,
  __forTesting,
  type VoiceTranscriber,
} from '../src/services/voiceAssistant.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

// ---------------------------------------------------------------------------
// Vertex text-client fake (same shape runAssistantQuery accepts)
// ---------------------------------------------------------------------------

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

function makeTextClient(queue: GenerateContentResponse[]): VertexClient & {
  calls: number;
} {
  const client = {
    enabled: true,
    calls: 0,
    async generate(): Promise<GenerateContentResponse> {
      client.calls += 1;
      const next = queue.shift();
      if (next === undefined) throw new Error('text queue empty');
      return next;
    },
  };
  return client;
}

/** A transcriber that returns a fixed transcript, ignoring the audio. */
function fixedTranscriber(transcript: string): VoiceTranscriber {
  return async (): Promise<TranscribeAndParseResult> => ({
    transcript,
    intents: [],
    empty_reason: transcript === '' ? 'empty_transcript' : null,
  });
}

const AUDIO = Buffer.from('OggS-fake-voice-bytes');

// ---------------------------------------------------------------------------
// 1. Happy path — staged create_replenishment_request for the OWN store
// ---------------------------------------------------------------------------

describe('runVoiceAssistant — spoken supply request', () => {
  it('stages a create_replenishment_request pending action and echoes transcript', async () => {
    const store = await makeLocation(ctx.db, { type: 'store', name: 'Voice Store A' });
    const napoleon = await makeProduct(ctx.db, {
      name: 'Г/П НАПОЛЕОН',
      type: 'finished',
    });
    await setStock(ctx.db, {
      locationId: store,
      productId: napoleon,
      qty: 2,
      minLevel: 5,
      maxLevel: 30,
    });
    const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    // The model: turn 0 proposes the write tool for the caller's own store,
    // turn 1 asks to confirm in text.
    const client = makeTextClient([
      callResponse('create_replenishment_request', {
        product_id: napoleon,
        requester_location_id: store,
        qty_needed: 10,
      }),
      textResponse('Г/П НАПОЛЕОН × 10 so\'rovini tayyorladim. Tasdiqlaysizmi?'),
    ]);

    const out = await runVoiceAssistant({
      audio: AUDIO,
      principal: {
        userId: sm.id,
        role: 'store_manager',
        locationId: store,
        locationIds: [store],
        activeLocationId: store,
      },
      transcribe: fixedTranscriber('menga 10 ta napoleon kerak'),
      client,
    });

    expect(out.transcript).toBe('menga 10 ta napoleon kerak');
    expect(out.session_id).toEqual(expect.any(Number));
    expect(out.pending_action).toBeDefined();
    expect(out.pending_action?.tool_name).toBe('create_replenishment_request');
    expect(out.pending_action?.args).toMatchObject({
      product_id: napoleon,
      requester_location_id: store,
      qty_needed: 10,
    });
    expect(out.pending_action?.action_id).toEqual(expect.any(Number));

    // The pending row really landed in assistant_actions (status 'pending').
    const { rows } = await ctx.db.query<{ status: string; tool_name: string }>(
      `SELECT status, tool_name FROM assistant_actions WHERE id = $1`,
      [out.pending_action!.action_id],
    );
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.tool_name).toBe('create_replenishment_request');
  });
});

// ---------------------------------------------------------------------------
// 2. RBAC — a store manager cannot stage a request for a FOREIGN location
// ---------------------------------------------------------------------------

describe('runVoiceAssistant — RBAC', () => {
  it('denies a foreign requester_location_id (no pending action staged)', async () => {
    const myStore = await makeLocation(ctx.db, { type: 'store', name: 'Voice My Store' });
    const otherStore = await makeLocation(ctx.db, {
      type: 'store',
      name: 'Voice Other Store',
    });
    const product = await makeProduct(ctx.db, { name: 'Tort', type: 'finished' });
    const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: myStore });

    // The model (mis)targets the OTHER store. canExecute must deny it.
    const client = makeTextClient([
      callResponse('create_replenishment_request', {
        product_id: product,
        requester_location_id: otherStore,
        qty_needed: 5,
      }),
      textResponse('Bu bo\'g\'in uchun so\'rov yarata olmaysiz.'),
    ]);

    const out = await runVoiceAssistant({
      audio: AUDIO,
      principal: {
        userId: sm.id,
        role: 'store_manager',
        locationId: myStore,
        locationIds: [myStore],
        activeLocationId: myStore,
      },
      transcribe: fixedTranscriber('boshqa do\'konga tort kerak'),
      client,
    });

    expect(out.transcript).toBe('boshqa do\'konga tort kerak');
    expect(out.pending_action).toBeUndefined();

    // No pending assistant_actions row for the other store was created.
    const { rows } = await ctx.db.query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM assistant_actions
        WHERE user_id = $1 AND status = 'pending'`,
      [sm.id],
    );
    expect(Number(rows[0]?.cnt ?? '0')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Graceful empty / unintelligible audio
// ---------------------------------------------------------------------------

describe('runVoiceAssistant — graceful empty audio', () => {
  it('returns a "tushunmadim" reply for an empty buffer (no Vertex call)', async () => {
    const store = await makeLocation(ctx.db, { type: 'store', name: 'Voice Empty Buf' });
    const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const client = makeTextClient([]); // must never be consulted

    const out = await runVoiceAssistant({
      audio: Buffer.alloc(0),
      principal: {
        userId: sm.id,
        role: 'store_manager',
        locationId: store,
        locationIds: [store],
        activeLocationId: store,
      },
      transcribe: fixedTranscriber('should not be called'),
      client,
    });

    expect(out.transcript).toBe('');
    expect(out.session_id).toBeNull();
    expect(out.response).toBe(__forTesting.UNINTELLIGIBLE_REPLY);
    expect(out.pending_action).toBeUndefined();
    expect(out.tool_calls).toEqual([]);
    expect(client.calls).toBe(0);
  });

  it('returns a "tushunmadim" reply for a blank transcript', async () => {
    const store = await makeLocation(ctx.db, { type: 'store', name: 'Voice Blank Tx' });
    const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const client = makeTextClient([]);

    const out = await runVoiceAssistant({
      audio: AUDIO,
      principal: {
        userId: sm.id,
        role: 'store_manager',
        locationId: store,
        locationIds: [store],
        activeLocationId: store,
      },
      transcribe: fixedTranscriber('   '), // whitespace → blank after trim
      client,
    });

    expect(out.transcript).toBe('');
    expect(out.session_id).toBeNull();
    expect(out.response).toBe(__forTesting.UNINTELLIGIBLE_REPLY);
    expect(client.calls).toBe(0);

    // No assistant_sessions row created on the unintelligible path.
    const { rows } = await ctx.db.query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM assistant_sessions WHERE user_id = $1`,
      [sm.id],
    );
    expect(Number(rows[0]?.cnt ?? '0')).toBe(0);
  });

  it('degrades gracefully when transcription throws', async () => {
    const store = await makeLocation(ctx.db, { type: 'store', name: 'Voice Throw Tx' });
    const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const client = makeTextClient([]);
    const throwingTranscriber: VoiceTranscriber = async () => {
      throw new Error('vertex audio transport blew up');
    };

    const out = await runVoiceAssistant({
      audio: AUDIO,
      principal: {
        userId: sm.id,
        role: 'store_manager',
        locationId: store,
        locationIds: [store],
        activeLocationId: store,
      },
      transcribe: throwingTranscriber,
      client,
    });

    expect(out.response).toBe(__forTesting.UNINTELLIGIBLE_REPLY);
    expect(out.session_id).toBeNull();
    expect(client.calls).toBe(0);
  });
});
