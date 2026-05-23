/**
 * F2.2 — `runAssistantQuery` unit tests (service-layer).
 *
 * Whereas `routes.assistant.test.ts` covers the full HTTP loop, this file
 * pokes the service directly with an injected fake `VertexClient`. Three
 * thin invariants:
 *
 *   1. The system prompt the service hands to Vertex carries the principal's
 *      role + location scope — that's how we satisfy ADR-0006 §5.
 *   2. The tool-call loop respects `cfg.vertex.maxToolCallsPerTurn` — a model
 *      that loops forever falls back to a "tool chain limit reached"
 *      message rather than hanging.
 *   3. A disabled client throws `VERTEX_UNAVAILABLE` (no GCP round-trip,
 *      no DB write).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GenerateContentResult } from '@google-cloud/vertexai';
import type { VertexClient } from '../src/integrations/vertex/client.js';
import { runAssistantQuery } from '../src/services/assistant.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

function textResponse(text: string): GenerateContentResult {
  return {
    response: {
      candidates: [
        {
          content: { role: 'model', parts: [{ text }] },
          index: 0,
        } as unknown as GenerateContentResult['response']['candidates'][number],
      ],
    },
  } as GenerateContentResult;
}

function callResponse(
  name: string,
  args: Record<string, unknown>,
): GenerateContentResult {
  return {
    response: {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name, args } }],
          },
          index: 0,
        } as unknown as GenerateContentResult['response']['candidates'][number],
      ],
    },
  } as GenerateContentResult;
}

function makeClient(queue: GenerateContentResult[], capture: {
  systemInstructions: string[];
}): VertexClient {
  return {
    enabled: true,
    async generate(req) {
      capture.systemInstructions.push(req.systemInstruction);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('queue empty');
      }
      return next;
    },
  };
}

describe('runAssistantQuery — system prompt + scope', () => {
  it('includes the principal role in the system instruction', async () => {
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: storeId });
    const capture = { systemInstructions: [] as string[] };
    const client = makeClient([textResponse('OK')], capture);

    const out = await runAssistantQuery({
      message: 'Salom',
      principal: {
        userId: sm.id,
        role: 'store_manager',
        locationId: storeId,
      },
      client,
    });

    expect(out.response).toBe('OK');
    expect(capture.systemInstructions[0]).toMatch(/store_manager/);
  });
});

describe('runAssistantQuery — tool-call chain limit', () => {
  it('stops after maxToolCallsPerTurn and returns a fallback message', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });

    // Push function-call responses indefinitely — the service must cap on
    // its own. Default cap = 5; queue 7 to be safe.
    const queue: GenerateContentResult[] = [];
    for (let i = 0; i < 7; i++) {
      queue.push(callResponse('get_below_min', {}));
    }

    const capture = { systemInstructions: [] as string[] };
    const client = makeClient(queue, capture);

    const out = await runAssistantQuery({
      message: 'Hammasi qancha?',
      principal: { userId: pm.id, role: 'pm', locationId: null },
      client,
    });

    expect(out.response).toMatch(/zanjir chegarasi/i);
    // The service must have stopped issuing more generate() calls — fewer
    // than 7 even though the queue had 7 ready.
    expect(capture.systemInstructions.length).toBeLessThanOrEqual(6);
  });
});

describe('runAssistantQuery — disabled client', () => {
  it('throws VERTEX_UNAVAILABLE without touching the DB', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const disabled: VertexClient = {
      enabled: false,
      async generate() {
        throw new Error('should not be called');
      },
    };
    await expect(
      runAssistantQuery({
        message: 'Salom',
        principal: { userId: pm.id, role: 'pm', locationId: null },
        client: disabled,
      }),
    ).rejects.toThrow(/VERTEX_UNAVAILABLE/);

    // No assistant_sessions row created.
    const { rows } = await ctx.db.query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM assistant_sessions WHERE user_id = $1`,
      [pm.id],
    );
    expect(Number(rows[0]?.cnt ?? '0')).toBe(0);
  });
});
