/**
 * Vertex smoke test — `npm run vertex:test -w @adia/backend`.
 *
 * Issues ONE real `generateContent` call against the configured Gemini model
 * and prints the answer plus token-usage. The script is intentionally tiny —
 * it does not touch the database, does not exercise tool calling, and does
 * not start the Express app. Its job is to confirm that:
 *
 *   1. `VERTEX_PROJECT_ID`, `VERTEX_REGION`, `VERTEX_MODEL` are wired right;
 *   2. `GOOGLE_APPLICATION_CREDENTIALS` points at a readable service-account
 *      key with `roles/aiplatform.user` (or equivalent);
 *   3. the Gemini endpoint responds with text inside the model timeout.
 *
 * It exits 0 on success, 1 on any failure (so CI can gate on it later).
 */
import { loadConfig } from '../src/config/index.js';
import { defaultVertexClient, isVertexEnabled } from '../src/integrations/vertex/client.js';

async function main(): Promise<void> {
  // The config module flips `vertex.enabled` to false in `NODE_ENV=test`.
  // Force `development` so the smoke test works regardless of shell env.
  if (process.env.NODE_ENV === 'test') {
    process.env.NODE_ENV = 'development';
  }
  const cfg = loadConfig();

  if (!isVertexEnabled()) {
    console.error(
      '[vertex-test] disabled — set VERTEX_PROJECT_ID and ' +
        'GOOGLE_APPLICATION_CREDENTIALS in your .env, then retry.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('[vertex-test]', {
    project: cfg.vertex.projectId,
    region: cfg.vertex.region,
    model: cfg.vertex.model,
  });

  const t0 = Date.now();
  try {
    const result = await defaultVertexClient.generate({
      systemInstruction:
        'You are a terse assistant. Answer in one short sentence.',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Salom! Bir gap bilan o\'zingni tanishtir.' }],
        },
      ],
      tools: [],
    });
    const elapsedMs = Date.now() - t0;
    const candidate = result.response.candidates?.[0];
    const text =
      candidate?.content?.parts
        ?.map((p) => ('text' in p && typeof p.text === 'string' ? p.text : ''))
        .join('') ?? '';
    const usage = result.response.usageMetadata;
    console.log('[vertex-test] ok', { elapsedMs });
    console.log('--- response ---');
    console.log(text);
    console.log('--- usage ---');
    console.log({
      promptTokenCount: usage?.promptTokenCount,
      candidatesTokenCount: usage?.candidatesTokenCount,
      totalTokenCount: usage?.totalTokenCount,
    });
  } catch (err) {
    console.error('[vertex-test] FAILED', (err as Error).message);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[vertex-test] uncaught', err);
  process.exitCode = 1;
});
