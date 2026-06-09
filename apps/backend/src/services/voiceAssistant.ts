/**
 * Voice → AI-assistant-action service (EPIC: web voice assistant).
 *
 * One entrypoint: `runVoiceAssistant({ audio, mimeType?, principal, sessionId?,
 * transcribe?, client? })`.
 *
 * It glues two pieces that already exist — it does NOT re-implement either:
 *
 *   1. TRANSCRIBE — hand the raw audio bytes to the Vertex multimodal model via
 *      `transcribeAndParseVoice` (`integrations/vertex/parseVoiceAudio.ts`). We
 *      consume ONLY the `transcript` it returns; the structured `intents` it
 *      also produces are ignored here, because the assistant query flow re-does
 *      the intent extraction with the FULL write-tool surface (so a spoken
 *      "menga 10 ta napoleon kerak" becomes a `create_replenishment_request`
 *      pending action, identical to typing the same sentence into
 *      `POST /api/assistant/query`).
 *
 *   2. REASON + STAGE — feed the transcript into `runAssistantQuery`
 *      (`services/assistant.ts`) UNCHANGED, with write tools enabled. The
 *      pending-action lifecycle (`assistant_actions`, `/actions/:id/confirm`,
 *      `/reject`) is therefore reused verbatim.
 *
 * The result is the SAME shape as `runAssistantQuery` plus the `transcript`
 * string, so the frontend renders the spoken request and the confirm dialog
 * with the existing components.
 *
 * Robustness (graceful degradation, never throw on bad audio):
 *   - empty / silent / unintelligible audio → a `transcript: ''` outcome is
 *     turned into a friendly "tushunmadim" reply with no `pending_action` and
 *     no Vertex text round-trip — the caller surfaces it as a normal 200.
 *
 * RBAC: the assistant query carries `principal` verbatim; the write tool's
 * `canExecute` pins `requester_location_id` to a location the caller manages,
 * and the system prompt steers a non-PM caller to their own active location.
 */
import { Buffer } from 'node:buffer';
import type { AuthPrincipal } from '../auth/jwt.js';
import type { VertexClient } from '../integrations/vertex/client.js';
import {
  transcribeAndParseVoice,
  getLocationCatalogNames,
  type TranscribeAndParseResult,
} from '../integrations/vertex/parseVoiceAudio.js';
import {
  runAssistantQuery,
  type RunAssistantQueryResult,
} from './assistant.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The transcription seam. Production passes `transcribeAndParseVoice`; tests
 * inject a fake so the suite never touches GCP. Returns the same shape as
 * `transcribeAndParseVoice` — we only read `.transcript`.
 */
export type VoiceTranscriber = (input: {
  audio: Buffer;
  mimeType: string;
  principal: AuthPrincipal;
  catalogNames: readonly string[];
}) => Promise<TranscribeAndParseResult>;

export type RunVoiceAssistantInput = {
  /** Raw audio bytes (OGG/Opus, WebM, etc.). */
  readonly audio: Buffer;
  /** Audio MIME type — defaults to `audio/ogg`. */
  readonly mimeType?: string;
  /** Authenticated principal — sets RBAC scope + the system-prompt location. */
  readonly principal: AuthPrincipal;
  /** Optional — continue an existing assistant session. */
  readonly sessionId?: number;
  /** Test seam — override the transcription step. */
  readonly transcribe?: VoiceTranscriber;
  /** Test seam — forwarded to `runAssistantQuery` (fake Vertex text client). */
  readonly client?: VertexClient;
};

/**
 * The voice result == the assistant-query result + the heard transcript.
 *
 * `session_id` is `null` ONLY when the audio was unintelligible and we never
 * created a session (the "tushunmadim" path). On every transcribed path it is
 * the assistant session id, exactly like `POST /api/assistant/query`.
 */
export type RunVoiceAssistantResult = {
  readonly transcript: string;
  readonly session_id: number | null;
  readonly response: string;
  readonly tool_calls: RunAssistantQueryResult['tool_calls'];
  readonly pending_action?: RunAssistantQueryResult['pending_action'];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_AUDIO_MIME = 'audio/ogg';

/** Friendly reply when nothing intelligible was heard (no crash, no Vertex). */
const UNINTELLIGIBLE_REPLY =
  "Kechirasiz, ovozli xabarni tushunmadim. Iltimos, qaytadan, " +
  "tinchroq joyda gapirib yuboring.";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runVoiceAssistant(
  input: RunVoiceAssistantInput,
): Promise<RunVoiceAssistantResult> {
  const mimeType = input.mimeType ?? DEFAULT_AUDIO_MIME;
  const principal = input.principal;

  // Guard — empty buffer never reaches Vertex (saves a round-trip, and the
  // model would only echo silence). Surface the graceful reply.
  if (input.audio.length === 0) {
    return unintelligible();
  }

  // 1. Transcribe. The catalog (the caller location's Russian product names)
  //    sharpens Uzbek → Russian product mapping, exactly like the Telegram
  //    voice flow. A fresh location with no stock rows yields an empty list and
  //    the model falls back to phonetic resolution.
  const transcribe = input.transcribe ?? defaultTranscribe;
  const catalogNames = await getLocationCatalogNames(
    principal.activeLocationId ?? principal.locationId,
  );

  let transcript = '';
  try {
    const out = await transcribe({
      audio: input.audio,
      mimeType,
      principal,
      catalogNames,
    });
    transcript = out.transcript.trim();
  } catch {
    // Transcription transport failed — do NOT crash the request. Treat it the
    // same as "couldn't understand"; the caller returns a 200 with the
    // friendly reply rather than a 5xx.
    return unintelligible();
  }

  if (transcript === '') {
    return unintelligible();
  }

  // 2. Hand the transcript to the SAME assistant query flow (write tools on).
  //    `runAssistantQuery` owns the Gemini/tool plumbing, session persistence,
  //    audit, and the pending-action staging — we add nothing to it.
  const result = await runAssistantQuery({
    message: transcript,
    principal,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.client !== undefined ? { client: input.client } : {}),
  });

  return {
    transcript,
    session_id: result.session_id,
    response: result.response,
    tool_calls: result.tool_calls,
    ...(result.pending_action !== undefined
      ? { pending_action: result.pending_action }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Production transcriber — Vertex multimodal, transcript only. */
const defaultTranscribe: VoiceTranscriber = (input) =>
  transcribeAndParseVoice({
    audio: input.audio,
    mimeType: input.mimeType,
    principal: input.principal,
    catalogNames: input.catalogNames,
  });

/** The graceful "couldn't understand" outcome — no session, no pending action. */
function unintelligible(): RunVoiceAssistantResult {
  return {
    transcript: '',
    session_id: null,
    response: UNINTELLIGIBLE_REPLY,
    tool_calls: [],
  };
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export const __forTesting = {
  UNINTELLIGIBLE_REPLY,
  DEFAULT_AUDIO_MIME,
};
