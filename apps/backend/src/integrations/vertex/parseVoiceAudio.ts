/**
 * B1 (telegram-bot-tz §2) — Audio → transcript + structured request in ONE
 * Gemini 2.5 Flash call.
 *
 * The OLD flow was two hops: Yandex SpeechKit (uz-UZ) → transcript, then a
 * separate Vertex `parse_movements` call. proaudit.app proved a single hop is
 * both cheaper and more accurate: hand the .oga bytes DIRECTLY to a multimodal
 * model with an `inlineData` audio part, and let it BOTH transcribe (Uzbek
 * speech) AND emit the structured request via function calling.
 *
 * Accuracy lever (egasi urg'usi, §2): the products carry RUSSIAN names
 * (НАПОЛЕОН, ПЕЛЬМЕНИ, САМСА…) but the manager SPEAKS Uzbek. We therefore pass
 * the requester location's product catalog (the Russian names it actually
 * stocks) as context so "yigirmata napoleon" maps to НАПОЛЕОН ×20 instead of a
 * phonetic guess. The prompt itself is in Uzbek.
 *
 * Hallucination guard is unchanged: the model returns product NAMES only; the
 * server resolves names → ids via `resolveProduct` in voiceHandler. The catalog
 * is a HINT, not an authority — a name the model returns that is not in the
 * catalog still goes through the normal DB resolution.
 */
import { Buffer } from 'node:buffer';
import {
  Type,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type Part,
  type Tool,
} from '@google/genai';
import type { AuthPrincipal } from '../../auth/jwt.js';
import { query } from '../../db/index.js';
import {
  defaultVertexClient,
  isVertexEnabled,
  type VertexClient,
} from './client.js';
import type { ParsedIntent } from './parseIntent.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TranscribeAndParseResult = {
  /** Faithful transcript of the audio (echoed to the user). */
  readonly transcript: string;
  readonly intents: ParsedIntent[];
  readonly empty_reason: 'no_function_call' | 'no_intents' | 'empty_transcript' | null;
};

/** Max product names injected into the prompt — keeps the context bounded for
 *  large catalogs (1.7k products) while covering a store's real assortment. */
const MAX_CATALOG_NAMES = 120;

// ---------------------------------------------------------------------------
// Function declaration — transcript + movements in one structured call
// ---------------------------------------------------------------------------

const transcribeRequestDecl: FunctionDeclaration = {
  name: 'submit_voice_request',
  description:
    'Transcribe the audio (Uzbek speech) and extract the cross-department ' +
    'supply request it contains. Always return the faithful transcript plus ' +
    'the requested products. Map each spoken product to the CLOSEST catalog ' +
    'name provided in the system prompt (catalog names are in Russian). Do ' +
    'not invent product or location ids — the server resolves names to ids.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      transcript: {
        type: Type.STRING,
        description:
          "Audioning to'liq transkripsiyasi (foydalanuvchi qaysi tilda " +
          "gapirgan bo'lsa — odatda o'zbekcha).",
      },
      movements: {
        type: Type.ARRAY,
        description:
          "So'ralgan mahsulotlar ro'yxati. Har bir element bitta mahsulot.",
        items: {
          type: Type.OBJECT,
          properties: {
            action: {
              type: Type.STRING,
              description:
                'Odatda "request" (boshqa bo\'limdan so\'rash — "kerak", ' +
                '"yuboring", "jo\'nating"). Kirim bo\'lsa "adjust_in", ' +
                'chiqim "adjust_out", ko\'chirish "transfer".',
            },
            product_name: {
              type: Type.STRING,
              description:
                "Mahsulot nomi — IMKON BORICHA katalogdagi (ruscha) nomга " +
                "moslang. Masalan eshitilgan \"napoleon\" → \"НАПОЛЕОН\".",
            },
            qty: {
              type: Type.NUMBER,
              description: "Musbat miqdor. Aniq aytilmasa qty=0, unit=\"unknown\".",
            },
            unit: {
              type: Type.STRING,
              description: 'Birlik: "dona", "kg", "l", "paket", "qop" yoki "unknown".',
            },
            from_location_hint: {
              type: Type.STRING,
              description: 'Manba lokatsiya nomi (transfer uchun). Aks holda bo\'sh.',
            },
            to_location_hint: {
              type: Type.STRING,
              description: 'Maqsad lokatsiya nomi (agar aytilgan bo\'lsa). Aks holda bo\'sh.',
            },
          },
          required: ['action', 'product_name', 'qty', 'unit'],
        },
      },
    },
    required: ['transcript', 'movements'],
  },
};

// ---------------------------------------------------------------------------
// Catalog context — the requester location's stocked product names
// ---------------------------------------------------------------------------

/**
 * Fetch up to {MAX_CATALOG_NAMES} active product names stocked at a location —
 * this is the location's real assortment, used as STT mapping context. We
 * prefer products that have a stock row at the location (the actual catalog);
 * if the location has no stock rows yet (fresh seed) we return an empty list
 * and the model falls back to phonetic resolution + DB lookup.
 */
export async function getLocationCatalogNames(
  locationId: number | null,
): Promise<string[]> {
  if (locationId === null) return [];
  const { rows } = await query<{ name: string }>(
    `SELECT p.name
       FROM stock s
       JOIN products p ON p.id = s.product_id
      WHERE s.location_id = $1 AND p.is_active = TRUE
      ORDER BY p.name
      LIMIT $2`,
    [locationId, MAX_CATALOG_NAMES],
  );
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// System prompt — Uzbek, with the Russian catalog injected
// ---------------------------------------------------------------------------

export function buildVoiceAudioPrompt(
  principal: AuthPrincipal,
  catalogNames: readonly string[],
): string {
  const roleLine = `Foydalanuvchi roli: ${principal.role}.`;
  const locationLine =
    principal.locationId === null
      ? "Foydalanuvchi PM — barcha bo'limlar uchun gapirishi mumkin."
      : `Foydalanuvchining bo'limi (lokatsiya id): ${principal.locationId}.`;
  const catalogBlock =
    catalogNames.length > 0
      ? [
          '\n## Katalog (shu bo\'lim mahsulotlari — RUSCHA nomlar)\n',
          'Quyidagi nomlardan FOYDALANIB eshitilgan mahsulotni to\'g\'ri nomга moslang:\n',
          catalogNames.map((n) => `- ${n}`).join('\n'),
          '\n',
        ].join('')
      : '\n(Katalog konteksti yo\'q — eshitilgan nomni aynan yozing.)\n';

  return [
    "Sen ADIA ERP non/tort ishlab chiqarish ERP'sining ovozli yordamchisisan. ",
    "Foydalanuvchi (bo'lim boshlig'i) o'zbek tilida ovozli xabar yuboradi va ",
    "ustki bo'limdan mahsulot SO'RAYDI (masalan: \"menga yigirmata napoleon kerak\"). ",
    "Sening vazifang — `submit_voice_request` funksiyasini chaqirish: audioni ",
    "transkripsiya qil VA so'ralgan mahsulotlarni ajrat.\n\n",
    '## Muhim qoidalar\n',
    "- Mahsulot nomlari RUSCHA (НАПОЛЕОН, ПЕЛЬМЕНИ, САМСА...). Eshitilgan o'zbekcha ",
    "nutqni katalogdagi eng yaqin RUSCHA nomга moslang.\n",
    '- Miqdor (qty) musbat butun/kasr son. Aniq aytilmasa qty=0, unit="unknown".\n',
    "- product_id yoki location_id QAYTARMA — faqat nom. Server o'zi ID ga aylantiradi.\n",
    "- Agar audio so'rov bo'lmasa (salomlashish/shovqin) — movements bo'sh massiv, ",
    "lekin transcript baribir to'ldiriladi.\n",
    '\n## Misol\n',
    '"menga yigirmata napoleon va ellikta somsa kerak" → transcript shu gap, ',
    'movements: [{action:"request", product_name:"НАПОЛЕОН", qty:20, unit:"dona"}, ',
    '{action:"request", product_name:"САМСА", qty:50, unit:"dona"}].\n',
    catalogBlock,
    '\n', roleLine, ' ', locationLine, '\n',
    "Har doim `submit_voice_request` ni chaqir — matn bilan emas, funksiya bilan javob ber.",
  ].join('');
}

// ---------------------------------------------------------------------------
// Shaping helpers (shared shape with parseIntent.ParsedIntent)
// ---------------------------------------------------------------------------

/**
 * Allowed action values. We accept the new `request` verb (cross-dept supply)
 * AND the legacy stock-movement verbs so the same path can also handle a
 * direct kirim/chiqim if the user phrases it that way. `request` is normalised
 * to `adjust_in`-shaped intent at the caller; here we keep it as a distinct
 * action the voiceHandler treats as a cross-department request.
 */
function shapeVoiceIntent(raw: unknown): ParsedIntent | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  let action =
    typeof obj.action === 'string' ? obj.action.trim().toLowerCase() : '';
  // Map the cross-dept "request" verb onto the request intent the handler
  // understands. Anything not in the known set is rejected.
  if (
    action !== 'request' &&
    action !== 'adjust_in' &&
    action !== 'adjust_out' &&
    action !== 'transfer'
  ) {
    return null;
  }
  const productName =
    typeof obj.product_name === 'string' ? obj.product_name.trim() : '';
  if (productName === '') return null;
  const qtyRaw = typeof obj.qty === 'number' ? obj.qty : Number(obj.qty);
  const qty = Number.isFinite(qtyRaw) && qtyRaw >= 0 ? qtyRaw : 0;
  const unitRaw = typeof obj.unit === 'string' ? obj.unit.trim().toLowerCase() : '';
  const unit = unitRaw === '' ? 'unknown' : unitRaw;
  const fromHint =
    typeof obj.from_location_hint === 'string' && obj.from_location_hint.trim() !== ''
      ? obj.from_location_hint.trim()
      : null;
  const toHint =
    typeof obj.to_location_hint === 'string' && obj.to_location_hint.trim() !== ''
      ? obj.to_location_hint.trim()
      : null;
  return {
    action: action as ParsedIntent['action'],
    product_name: productName,
    qty,
    unit,
    from_location_hint: fromHint,
    to_location_hint: toHint,
  };
}

function collectFunctionCalls(parts: readonly Part[]): FunctionCall[] {
  const calls: FunctionCall[] = [];
  for (const p of parts) {
    if ('functionCall' in p && p.functionCall !== undefined) {
      calls.push(p.functionCall);
    }
  }
  return calls;
}

function collectText(parts: readonly Part[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if ('text' in p && typeof p.text === 'string' && p.text.trim() !== '') {
      out.push(p.text.trim());
    }
  }
  return out.join(' ').trim();
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

/**
 * Transcribe `.oga` audio bytes and extract the cross-department request in a
 * single Gemini 2.5 Flash call.
 *
 * @throws when the Vertex transport fails — the caller falls back to Yandex.
 */
export async function transcribeAndParseVoice(opts: {
  audio: Buffer;
  mimeType?: string;
  principal: AuthPrincipal;
  catalogNames: readonly string[];
  client?: VertexClient;
}): Promise<TranscribeAndParseResult> {
  const ai = opts.client ?? defaultVertexClient;
  if (
    opts.client === undefined &&
    !ai.enabled &&
    !isVertexEnabled()
  ) {
    // Disabled mode — signal "no function call" so the voiceHandler can fall
    // back to Yandex (or report STT unavailable).
    return { transcript: '', intents: [], empty_reason: 'no_function_call' };
  }
  if (typeof ai.generateWithAudio !== 'function') {
    throw new Error('Vertex client does not support audio (generateWithAudio).');
  }

  const contents: Content[] = [
    {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: opts.mimeType ?? 'audio/ogg',
            data: opts.audio.toString('base64'),
          },
        },
        {
          text:
            "Ushbu ovozli xabarni transkripsiya qil va so'ralgan mahsulotlarni " +
            "`submit_voice_request` orqali qaytar.",
        },
      ],
    },
  ];
  const tools: Tool[] = [{ functionDeclarations: [transcribeRequestDecl] }];

  const response = await ai.generateWithAudio({
    systemInstruction: buildVoiceAudioPrompt(opts.principal, opts.catalogNames),
    contents,
    tools,
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const calls = collectFunctionCalls(parts);
  const textFallback = collectText(parts);

  if (calls.length === 0) {
    // No structured call — the model may still have produced a bare transcript
    // as text. Surface it so the user at least sees what was heard.
    return {
      transcript: textFallback,
      intents: [],
      empty_reason: textFallback === '' ? 'empty_transcript' : 'no_function_call',
    };
  }

  const call = calls[0]!;
  const rawArgs = (call.args ?? {}) as Record<string, unknown>;
  const transcript =
    typeof rawArgs.transcript === 'string' && rawArgs.transcript.trim() !== ''
      ? rawArgs.transcript.trim()
      : textFallback;
  const movementsRaw = rawArgs.movements;
  const intents: ParsedIntent[] = [];
  if (Array.isArray(movementsRaw)) {
    for (const m of movementsRaw) {
      const shaped = shapeVoiceIntent(m);
      if (shaped !== null) intents.push(shaped);
    }
  }
  let emptyReason: TranscribeAndParseResult['empty_reason'] = null;
  if (transcript === '') {
    emptyReason = 'empty_transcript';
  } else if (intents.length === 0) {
    emptyReason = 'no_intents';
  }
  return { transcript, intents, empty_reason: emptyReason };
}

// ---------------------------------------------------------------------------
// TEST seams
// ---------------------------------------------------------------------------

export const __forTesting = {
  transcribeRequestDecl,
  shapeVoiceIntent,
  buildVoiceAudioPrompt,
  MAX_CATALOG_NAMES,
};
