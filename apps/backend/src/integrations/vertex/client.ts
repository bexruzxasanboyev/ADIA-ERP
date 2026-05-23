/**
 * Vertex AI Gemini client wrapper — Phase-2 F2.2 (ADR-0006).
 *
 * Responsibilities:
 *  - lazily build a single `GenerativeModel` for the configured Gemini model
 *    using Application Default Credentials (ADC). The `@google-cloud/vertexai`
 *    SDK reads `GOOGLE_APPLICATION_CREDENTIALS` automatically — we never
 *    parse service-account keys ourselves and never log their contents.
 *  - expose a single `generate()` entrypoint that issues one round-trip to
 *    Vertex. Multi-turn / multi-tool orchestration lives in the assistant
 *    service (`src/services/assistant.ts`).
 *  - stay completely silent in test / disabled mode so the existing 291
 *    tests do not touch GCP. `isVertexEnabled()` mirrors `cfg.vertex.enabled`;
 *    every caller MUST gate on it.
 *
 * The exported `VertexClient` interface lets tests inject a fake — see
 * `test/assistant.test.ts`.
 */
import { VertexAI, type GenerativeModel } from '@google-cloud/vertexai';
import type {
  Content,
  GenerateContentResult,
  Tool,
} from '@google-cloud/vertexai';
import { loadConfig } from '../../config/index.js';

/**
 * Minimal request shape — only the fields the assistant service actually
 * sets. Keeping it narrow makes the test fake trivial to author.
 */
export type VertexGenerateRequest = {
  readonly systemInstruction: string;
  readonly contents: Content[];
  readonly tools: Tool[];
};

export type VertexClient = {
  /** True when the SDK is wired and ADC credentials are present. */
  readonly enabled: boolean;
  /**
   * Issue a single `generateContent` round-trip. Throws on transport
   * errors; callers translate that into an `AI_TOOL_ERROR` response.
   */
  generate(req: VertexGenerateRequest): Promise<GenerateContentResult>;
};

let cached: GenerativeModel | undefined;

function getModel(): GenerativeModel {
  if (cached !== undefined) {
    return cached;
  }
  const cfg = loadConfig();
  if (!cfg.vertex.enabled) {
    // Defensive — callers should never reach this branch (gate on
    // `isVertexEnabled()` first).
    throw new Error(
      'Vertex client is disabled — set VERTEX_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS.',
    );
  }
  const vertex = new VertexAI({
    project: cfg.vertex.projectId,
    location: cfg.vertex.region,
  });
  cached = vertex.getGenerativeModel({
    model: cfg.vertex.model,
    generationConfig: {
      maxOutputTokens: cfg.vertex.maxOutputTokens,
      temperature: 0.2, // deterministic-leaning — domain answers, not creative writing
    },
  });
  return cached;
}

export function isVertexEnabled(): boolean {
  return loadConfig().vertex.enabled;
}

/**
 * Default production client — talks to the real Vertex API. Tests pass a
 * fake `VertexClient` directly to the assistant service.
 */
export const defaultVertexClient: VertexClient = {
  get enabled(): boolean {
    return isVertexEnabled();
  },
  async generate(req: VertexGenerateRequest): Promise<GenerateContentResult> {
    const model = getModel();
    return model.generateContent({
      systemInstruction: { role: 'system', parts: [{ text: req.systemInstruction }] },
      contents: req.contents,
      tools: req.tools,
    });
  },
};

/** TEST-ONLY: drop the memoised GenerativeModel so a new config takes effect. */
export function resetVertexClientCache(): void {
  cached = undefined;
}
