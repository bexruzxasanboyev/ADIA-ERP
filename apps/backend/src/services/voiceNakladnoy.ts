/**
 * EPIC 8.6 — golosovoy (ovozli xabar) → nakladnoy.
 *
 * Owner scenario (changes-2026-05-owner-feedback.md §8.6): a store sends a
 * VOICE message when it receives product ("Filial-2 ga 10 ta Napoleon keldi")
 * → the system forms a nakladnoy. The voice → STT → Vertex intent-parse →
 * product-resolution chain ALREADY exists (F4.3 / ADR-0014: `voice_messages`,
 * `parseIntent`, the product name resolver). This module is the LAST link: it
 * turns one RESOLVED voice demand (product_id + qty + location) into a
 * material nakladnoy, reusing the EPIC 8.4 `createNakladnoy` BOM expansion and
 * tagging it `source='voice'` with `source_ref = voice_message_id` for the
 * forensic chain.
 *
 * INVARIANTS: reuses createNakladnoy (no stock mutation, no Poster write-back).
 * One audit row per nakladnoy (written by createNakladnoy).
 *
 * TODO(backend, 8.6 full wiring): hook `generateNakladnoyFromVoice` into the
 * Telegram voice handler so that an `adjust_in`/`transfer`-into-store intent
 * with a resolved product (status='parsed') auto-creates the nakladnoy and a
 * `view`-able notification to PM + store manager. The intent→product
 * resolution + clarification loop is the existing voiceHandler; only the call
 * site is pending. The unit below is fully exercised and ready to call.
 */
import type { TxClient } from '../db/index.js';
import { createNakladnoy, type NakladnoyResult } from './nakladnoy.js';
import { AppError } from '../errors/index.js';

export type VoiceNakladnoyInput = {
  /** The voice_messages.id this nakladnoy derives from (source_ref). */
  readonly voiceMessageId: number;
  /** Resolved finished product the store reported receiving. */
  readonly productId: number;
  /** Units reported (must be > 0 — a qty=0/unknown intent is a clarification, not a doc). */
  readonly qty: number;
  /** The store/location the voice came from (RBAC anchor on the nakladnoy). */
  readonly locationId: number;
  /** The ADIA user who sent the voice (audit actor). */
  readonly actorUserId: number | null;
  /** Optional free-text note (e.g. the transcript snippet). */
  readonly note?: string | null;
};

/**
 * Generate a `source='voice'` nakladnoy from a resolved voice demand. Throws
 * 422 when qty is not strictly positive (an unknown/zero qty must go through
 * the clarification loop first, never produce a document).
 */
export async function generateNakladnoyFromVoice(
  input: VoiceNakladnoyInput,
  tx?: TxClient,
): Promise<NakladnoyResult> {
  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    throw AppError.validation(
      'voice nakladnoy: qty must be > 0 (resolve the clarification first).',
    );
  }
  return createNakladnoy(
    {
      source: 'voice',
      sourceRef: String(input.voiceMessageId),
      productId: input.productId,
      qty: input.qty,
      locationId: input.locationId,
      note: input.note ?? null,
      actorUserId: input.actorUserId,
    },
    tx,
  );
}
