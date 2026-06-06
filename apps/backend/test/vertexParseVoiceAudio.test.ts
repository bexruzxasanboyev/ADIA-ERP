/**
 * B1 (telegram-bot-tz §2) — transcribeAndParseVoice unit tests.
 *
 * Mock the Vertex AUDIO client (`generateWithAudio`) so we exercise the
 * one-call "transcribe + extract" path WITHOUT touching GCP. The model is
 * expected to map Uzbek speech onto the Russian catalog names.
 */
import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import type {
  Content,
  GenerateContentResponse,
  Tool,
} from '@google/genai';
import {
  transcribeAndParseVoice,
  buildVoiceAudioPrompt,
  __forTesting,
} from '../src/integrations/vertex/parseVoiceAudio.js';
import type { VertexClient } from '../src/integrations/vertex/client.js';
import type { AuthPrincipal } from '../src/auth/jwt.js';

function principal(): AuthPrincipal {
  return {
    userId: 1,
    role: 'store_manager',
    locationId: 42,
    locationIds: [42],
    activeLocationId: 42,
  };
}

/** A fake audio client whose `generateWithAudio` returns the given parts. */
function mockAudioClient(parts: unknown[]): VertexClient {
  return {
    enabled: true,
    async generate(): Promise<GenerateContentResponse> {
      throw new Error('text generate() should not be called in the audio path');
    },
    async generateWithAudio(_req: {
      systemInstruction: string;
      contents: Content[];
      tools: Tool[];
    }): Promise<GenerateContentResponse> {
      return {
        candidates: [{ content: { parts: parts as never[] } }],
      } as unknown as GenerateContentResponse;
    },
  };
}

const audio = Buffer.from('OggS-fake-audio-bytes');

describe('transcribeAndParseVoice', () => {
  it('maps Uzbek speech to the Russian catalog name (napoleon → НАПОЛЕОН)', async () => {
    const client = mockAudioClient([
      {
        functionCall: {
          name: 'submit_voice_request',
          args: {
            transcript: 'menga yigirmata napoleon kerak',
            movements: [
              { action: 'request', product_name: 'НАПОЛЕОН', qty: 20, unit: 'dona' },
            ],
          },
        },
      },
    ]);
    const result = await transcribeAndParseVoice({
      audio,
      principal: principal(),
      catalogNames: ['НАПОЛЕОН', 'ПЕЛЬМЕНИ', 'САМСА'],
      client,
    });
    expect(result.transcript).toBe('menga yigirmata napoleon kerak');
    expect(result.empty_reason).toBeNull();
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]).toMatchObject({
      action: 'request',
      product_name: 'НАПОЛЕОН',
      qty: 20,
      unit: 'dona',
    });
  });

  it('extracts multiple requested products in one call', async () => {
    const client = mockAudioClient([
      {
        functionCall: {
          name: 'submit_voice_request',
          args: {
            transcript: 'yigirmata napoleon va ellikta somsa kerak',
            movements: [
              { action: 'request', product_name: 'НАПОЛЕОН', qty: 20, unit: 'dona' },
              { action: 'request', product_name: 'САМСА', qty: 50, unit: 'dona' },
            ],
          },
        },
      },
    ]);
    const result = await transcribeAndParseVoice({
      audio,
      principal: principal(),
      catalogNames: ['НАПОЛЕОН', 'САМСА'],
      client,
    });
    expect(result.intents).toHaveLength(2);
    expect(result.intents[1]?.product_name).toBe('САМСА');
  });

  it('returns transcript with empty intents when audio is just a greeting', async () => {
    const client = mockAudioClient([
      {
        functionCall: {
          name: 'submit_voice_request',
          args: { transcript: 'assalomu alaykum', movements: [] },
        },
      },
    ]);
    const result = await transcribeAndParseVoice({
      audio,
      principal: principal(),
      catalogNames: [],
      client,
    });
    expect(result.transcript).toBe('assalomu alaykum');
    expect(result.intents).toHaveLength(0);
    expect(result.empty_reason).toBe('no_intents');
  });

  it('falls back to a bare text transcript when no function call is made', async () => {
    const client = mockAudioClient([{ text: 'napoleon kerak edi' }]);
    const result = await transcribeAndParseVoice({
      audio,
      principal: principal(),
      catalogNames: [],
      client,
    });
    expect(result.transcript).toBe('napoleon kerak edi');
    expect(result.empty_reason).toBe('no_function_call');
  });

  it('reports empty_transcript when the model returns nothing usable', async () => {
    const client = mockAudioClient([{ text: '' }]);
    const result = await transcribeAndParseVoice({
      audio,
      principal: principal(),
      catalogNames: [],
      client,
    });
    expect(result.transcript).toBe('');
    expect(result.empty_reason).toBe('empty_transcript');
  });

  it('prompt is in Uzbek and injects the Russian catalog names', () => {
    const prompt = buildVoiceAudioPrompt(principal(), ['НАПОЛЕОН', 'САМСА']);
    expect(prompt).toContain('НАПОЛЕОН');
    expect(prompt).toContain('САМСА');
    // Uzbek instruction marker.
    expect(prompt.toLowerCase()).toContain('katalog');
    expect(prompt).toContain('submit_voice_request');
  });

  it('shapeVoiceIntent accepts the cross-dept "request" action', () => {
    const shaped = __forTesting.shapeVoiceIntent({
      action: 'request',
      product_name: 'НАПОЛЕОН',
      qty: 5,
      unit: 'dona',
    });
    expect(shaped).toMatchObject({ action: 'request', qty: 5 });
  });

  it('shapeVoiceIntent rejects an unknown action', () => {
    expect(
      __forTesting.shapeVoiceIntent({
        action: 'frobnicate',
        product_name: 'x',
        qty: 1,
        unit: 'dona',
      }),
    ).toBeNull();
  });
});
