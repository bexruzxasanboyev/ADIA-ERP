/**
 * ADR-0017 — Poster `storage_id` -> ADIA `location_type` mapping.
 *
 * Source of truth: live `storage.getStorages` (2026-05-29 diagnostic),
 * `docs/architecture/adr-0017-poster-storage-classification.md` §3.
 *
 * Why a declarative table: the previous `seedSync.upsertStorage` defaulted
 * ALL 25 Poster storages to `central_warehouse` (P1 bug) — the dashboard
 * "Markaziy sklad" card then swallowed all 25 storages. This mapping fixes
 * the classification at insert time AND makes the rule auditable in one place.
 */

/** ADIA `location_type` values relevant to Poster storage classification. */
export type StorageLocationType =
  | 'raw_warehouse'
  | 'central_warehouse'
  | 'production'
  | 'sex_storage';

/**
 * `storage_id` -> ADIA `location_type` (ADR-0017 §3, the 25 live storages).
 *
 * NOTE the store-backing storages 3/4/5 are INTENTIONALLY OMITTED — they are
 * not standalone locations. They are merged into their POS spot location
 * (P2, see `STORE_BACKING_STORAGE` + `upsertStorage`).
 */
export const STORAGE_TYPE_BY_ID: Readonly<Record<number, StorageLocationType>> = {
  2: 'raw_warehouse', // Основной склад — xom-ashyo ombori
  8: 'central_warehouse', // Склад Центральный — the ONE central warehouse
  20: 'production', // Производственный Цех — ishlab chiqarish floori
  // sex_storage — every remaining classified storage (ADR §3 rows).
  12: 'sex_storage', // Песочный
  15: 'sex_storage', // Самсы
  19: 'sex_storage', // Тортов
  21: 'sex_storage', // Каймок (OQ-1 — safe default)
  25: 'sex_storage', // Тартов
  26: 'sex_storage', // Бисквит
  27: 'sex_storage', // Декора
  28: 'sex_storage', // Спец (OQ-2 — safe default)
  29: 'sex_storage', // Горячих
  30: 'sex_storage', // Тошми (OQ-2 — safe default)
  31: 'sex_storage', // Минор (OQ-2 — safe default)
  32: 'sex_storage', // Наполеон
  33: 'sex_storage', // Салат (OQ-2 — safe default)
  34: 'sex_storage', // Эклеров
  35: 'sex_storage', // Заготовок (zagatovka buferi)
  36: 'sex_storage', // Украшений (ukrasheniye)
  37: 'sex_storage', // Круассанов
  38: 'sex_storage', // Евро
  39: 'sex_storage', // Пирогов
};

/**
 * Store-backing storages -> the POS `spot_id` they belong to (ADR-0017 §4).
 *
 * These storages are NOT inserted as standalone locations. Their
 * `poster_storage_id` is merged onto the matching `type='store'` spot row so
 * that BOTH sales (`poster_spot_id`) and stock (`poster_storage_id`) land on
 * the same single store location.
 */
export const STORE_BACKING_STORAGE: Readonly<Record<number, number>> = {
  3: 1, // Склад Кукча   -> spot 1 Кукча
  4: 2, // Склад Рабочий -> spot 2 Рабочий
  5: 3, // Склад Чигатай -> spot 3 Чигатай
};

/**
 * Safe default for any `storage_id` NOT in `STORAGE_TYPE_BY_ID` — e.g. a NEW
 * storage Poster adds later. `sex_storage` is non-disruptive: an unknown
 * storage never silently becomes central/raw/store. The PM reclassifies via
 * `PATCH /api/locations/:id`.
 */
export const DEFAULT_STORAGE_TYPE: StorageLocationType = 'sex_storage';

/** Resolve the classification for a storage id (default-safe). */
export function classifyStorage(storageId: number): StorageLocationType {
  return STORAGE_TYPE_BY_ID[storageId] ?? DEFAULT_STORAGE_TYPE;
}

/** True when this storage is store-backing and must be merged into a spot. */
export function isStoreBackingStorage(storageId: number): boolean {
  return storageId in STORE_BACKING_STORAGE;
}

// -----------------------------------------------------------------------------
// sex_storage -> production-department NAME matching (conservative attach).
// -----------------------------------------------------------------------------
//
// Poster has NO "production department" concept. ADIA models a production
// department as `locations.type='production'`; its physical storage is a
// `type='sex_storage'` row linked by `parent_id` -> the department. The Poster
// sync seeds the sex_storage rows (by product type: "Склад Тортов", "Склад
// Наполеон"…) but cannot know WHICH department each belongs under.
//
// This helper performs a CONSERVATIVE name match: it only returns a department
// when a department's name token is a substring of the (translit-normalised)
// storage name. The bar is deliberately high — an ambiguous storage returns
// null and is left for the owner to map by hand. We NEVER guess.

/**
 * Cyrillic -> Latin transliteration map covering the letters that appear in the
 * live Poster storage / ADIA department names. Lower-case only; callers
 * lower-case first. Multi-letter Cyrillic sounds expand to their usual Latin
 * digraphs so a Russian storage name can match a Latin (Uzbek) department name.
 */
const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya',
};

/**
 * Normalise a location name for matching: lower-case, transliterate Cyrillic to
 * Latin, drop the generic "sklad"/"sexi"/"cex"/"tseh" qualifier words, and
 * collapse to single spaces. The result is a stable comparison key in Latin.
 */
export function normaliseLocationName(name: string): string {
  const lower = name.toLowerCase().trim();
  let translit = '';
  for (const ch of lower) {
    translit += ch in CYRILLIC_TO_LATIN ? CYRILLIC_TO_LATIN[ch] : ch;
  }
  // Strip generic storage/department qualifier words — they are noise for the
  // product-type match (e.g. "sklad tortov" / "tort sexi" -> "tortov" / "tort").
  const STOP_WORDS = new Set(['sklad', 'sexi', 'sex', 'cex', 'tseh', 'skladi']);
  const tokens = translit
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
  return tokens.join(' ');
}

/** A production department candidate for the name match. */
export type DeptCandidate = { readonly id: number; readonly name: string };

/** The result of matching one sex_storage name against the departments. */
export type DeptMatch = {
  readonly deptId: number;
  readonly deptName: string;
  /** The normalised department token that matched inside the storage name. */
  readonly matchedToken: string;
};

/**
 * Find the production department a sex_storage's name CONFIDENTLY belongs under.
 *
 * Rule (conservative): a department matches when ANY of its normalised name
 * tokens (length >= 4 to avoid spurious 1-2 letter hits) is a substring of the
 * normalised storage name. The longest matched token wins when several
 * departments match (most specific). Returns null when nothing matches — the
 * caller leaves such a storage unparented for manual mapping.
 *
 * Why substring and not equality: Poster names the storage by the product
 * ("Склад Тортов" -> "tortov") while the department is named for the shop
 * ("Tort sexi" -> "tort"); the department token is the stem of the storage
 * name, so a substring test on the >=4-char token is the safe confident match.
 */
export function matchSexStorageToDept(
  storageName: string,
  depts: readonly DeptCandidate[],
): DeptMatch | null {
  const haystack = normaliseLocationName(storageName);
  if (haystack === '') return null;
  let best: DeptMatch | null = null;
  for (const dept of depts) {
    const deptTokens = normaliseLocationName(dept.name).split(' ').filter((t) => t.length >= 4);
    for (const token of deptTokens) {
      if (!haystack.includes(token)) continue;
      if (best === null || token.length > best.matchedToken.length) {
        best = { deptId: dept.id, deptName: dept.name, matchedToken: token };
      }
    }
  }
  return best;
}
