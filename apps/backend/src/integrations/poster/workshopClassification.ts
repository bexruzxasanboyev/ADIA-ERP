/**
 * Poster workshop (Цех) classification + dish→prepack name normalisation.
 *
 * Owner decision (2026-06-08): seed ONLY real PRODUCTION workshops as
 * `locations(type='production')`. A Poster workshop is EXCLUDED when its name:
 *   - starts with «Склад…» (a POS/storage, not a production dept), or
 *   - is a non-production display/dispatch area: «Витрина», «Кейтеринг», or a
 *     drinks area («… напитки»).
 * Everything else (the «… отдел» production depts including «Оформления отдел»
 * (decoration/assembly — owner 2026-06-08: now treated as production) +
 * «Основной», «Полуфабрикаты», «Адиа …», «Чак чак»…) is INCLUDED.
 *
 * The live `adia` split (verified 2026-06-08) is reported by the seed step for
 * owner review — this predicate is the single source of that decision.
 */

/** Normalise a workshop name for case/whitespace-insensitive matching. */
function normWs(name: string): string {
  return name.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * EXCLUDE a workshop from production seeding when true. Conservative + explicit:
 * a new Poster workshop that does not hit an exclusion rule defaults to INCLUDE
 * (it is reported in the seed split, so a wrong include is visible to the owner).
 */
export function isExcludedWorkshop(name: string): boolean {
  const n = normWs(name);
  if (n === '') return true;
  // Storage workshops («Склад Евро», «Склад Эклер»…) — POS/storage, not prod.
  // NB: JS `\b` is ASCII-only (no boundary after a Cyrillic letter), so we
  // anchor on a following space or end-of-string instead.
  if (/^склад(?:\s|$)/u.test(n)) return true;
  // Explicit non-production display / dispatch areas.
  // NB: «Оформления отдел» (decoration/assembly) is INCLUDED as production
  // per owner decision 2026-06-08 — no longer excluded here.
  if (n === 'витрина') return true;
  if (n === 'кейтеринг') return true;
  // Drinks workshops («холодные напитки», «горячие напитки»…) — not produced.
  if (/напитк/u.test(n)) return true;
  return false;
}

/** A workshop is included in production seeding when it is not excluded. */
export function isProductionWorkshop(name: string): boolean {
  return !isExcludedWorkshop(name);
}

/**
 * Normalise a product/prepack name for dish↔prepack name-matching:
 *   - uppercase;
 *   - strip a leading «Г/П» ready-prefix (with any separator/spacing);
 *   - strip ANY trailing parenthetical group(s) — portion size
 *     «(ЦЕЛЫЙ)» / «(ПОЛОВИНА)» / «(КУСОК)» AND flavour/variant/author tags
 *     «(АРАБИКА)», «(С ОРЕХОМ)», «(АХРОР АКА)», «(КВ)»… — up to two trailing
 *     groups (a few names carry two);
 *   - drop quote characters and collapse internal whitespace.
 *
 * Applied to BOTH sides so a Г/П prepack «Г/П ПИРОГ С ТВОРОГОМ КВ (ЦЕЛЫЙ)»
 * matches the dish «ПИРОГ С ТВОРОГОМ КВ», and every flavour variant
 * «Г/П САМСА (С МЯСОМ)», «Г/П САМСА (ОВОЩНАЯ)»… maps to the single base dish
 * «САМСА» — which is the intended enrichment (variants share the base dish's
 * category / image / workshop).
 *
 * DIAGNOSTIC (2026-06-08, live `adia`): generalising the old portion-only rule
 * to strip any trailing parenthetical raised exact dish-match coverage on the
 * 469 Г/П finished prepacks from 73 -> 150 (category +77, workshop 70 -> 147,
 * image 61 -> 130). The previous rule was a MATCHER gap, not Poster data
 * absence. Only 2 dish keys become category-ambiguous (МОРОЖЕНОЕ, БАУНТИ),
 * both harmless dessert-vs-dessert.
 *
 * Returns '' for an empty/degenerate name (callers MUST skip an empty key so
 * two unrelated empties never match).
 */
export function normalizeMatchName(name: string): string {
  return name
    .toUpperCase()
    .replace(/^\s*Г\s*[\\/]?\s*П\s*/u, '') // leading Г/П prefix
    .replace(/\s*\([^()]*\)\s*$/u, '') // trailing parenthetical group (1st)
    .replace(/\s*\([^()]*\)\s*$/u, '') // a 2nd trailing group, if any
    .replace(/[«»"']/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
