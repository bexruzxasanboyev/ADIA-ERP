/**
 * Bare-name → canonical "whole" product ranking (AI assistant product lookup).
 *
 * Poster names a finished cake family as one base dish plus portion / flavour
 * variants, all sharing a «Г/П» (ready) or «З/Г» (заготовка / semi) prefix and a
 * trailing parenthetical qualifier:
 *
 *   Г/П НАПОЛЕОН (ЦЕЛЫЙ)          ← the whole cake (what a bare "napoleon" means)
 *   Г/П НАПОЛЕОН (КАРАМЕЛЬНО)     ← a flavour variant
 *   Г/П НАПОЛЕОН АВГАНСКИЙ (ЦЕЛЫЙ)← a different (afghan) cake, also whole
 *   Г/П НАПОЛЕОН (ПОЛОВИНА)       ← a half portion
 *
 * When a user says just "napoleon", the assistant should resolve the canonical
 * WHOLE base cake (`Г/П НАПОЛЕОН (ЦЕЛЫЙ)`) rather than ask which of a dozen
 * variants they meant. This module provides a translit-aware match + a ranking
 * key that surfaces that variant first.
 *
 * It mirrors the name-stripping rules already used by the Poster matcher
 * (`integrations/poster/workshopClassification.ts#normalizeMatchName`) but adds
 * the «З/Г» prefix and exposes the trailing qualifier so a caller can tell a
 * whole portion from a flavour / half / piece.
 */
import { normalizeSearch } from './translit.js';

/** Portion qualifiers that denote a WHOLE unit (vs ПОЛОВИНА / КУСОК / flavour). */
const WHOLE_QUALIFIERS = new Set(['целый', 'целая', 'целое', 'whole']);

/** A product name split into its base "core" and its trailing qualifier. */
export type ParsedProductName = {
  /** Name minus the «Г/П»/«З/Г» ready prefix and the trailing «(…)» group. */
  readonly core: string;
  /** Lower-cased content of the trailing «(…)» group, or '' when absent. */
  readonly qualifier: string;
  /** True when the trailing qualifier denotes a whole unit («(ЦЕЛЫЙ)»). */
  readonly isWhole: boolean;
};

/**
 * Strip the leading «Г/П» / «З/Г» ready prefix from a (trimmed) name. Mirrors
 * `hasReadyPrefix` (`lib/productCategory.ts`) but also folds «З/Г» (заготовка),
 * and tolerates any separator / spacing (`Г/П`, `Г\П`, `ГП`, `Г П`, `З/Г`…).
 */
function stripReadyPrefix(name: string): string {
  return name.replace(/^\s*[гз]\s*[\\/]?\s*[пг]\s*(?=\S|$)/iu, '');
}

/**
 * Parse a product name into `{ core, qualifier, isWhole }`.
 *
 * - the leading «Г/П»/«З/Г» prefix is removed,
 * - the LAST trailing «(…)» group becomes `qualifier` (lower-cased),
 * - `core` is what remains, whitespace-collapsed.
 *
 * Only the final parenthetical is treated as the portion/variant qualifier so a
 * name like «НАПОЛЕОН (КВ) (ЦЕЛЫЙ)» keeps «КВ» inside the core and reads the
 * portion «ЦЕЛЫЙ» as the qualifier — matching how a person names the cake.
 */
export function parseProductName(name: string): ParsedProductName {
  const withoutPrefix = stripReadyPrefix(name.trim());
  let core = withoutPrefix;
  let qualifier = '';
  const m = withoutPrefix.match(/\(([^()]*)\)\s*$/u);
  if (m !== null) {
    qualifier = m[1]!.trim().toLowerCase();
    core = withoutPrefix.slice(0, m.index).trim();
  }
  core = core.replace(/\s+/gu, ' ').trim();
  return { core, qualifier, isWhole: WHOLE_QUALIFIERS.has(qualifier) };
}

/**
 * Ranking key for a candidate product name against a bare query, lower is
 * better. Used to ORDER an already-filtered candidate list so a bare
 * "napoleon" resolves to «Г/П НАПОЛЕОН (ЦЕЛЫЙ)» ahead of flavour / half / other
 * cakes that merely contain the word.
 *
 * Tiers (all comparisons are translit-normalised so Latin "napoleon" matches
 * Cyrillic "НАПОЛЕОН"):
 *   0  core == query AND whole portion        → «Г/П НАПОЛЕОН (ЦЕЛЫЙ)»
 *   1  core == query, no/other qualifier      → «НАПОЛЕОН» with no «(…)»
 *   2  core == query but a non-whole portion  → «(ПОЛОВИНА)» / «(КУСОК)»
 *   3  core == query but a flavour variant    → «(КАРАМЕЛЬНО)»
 *   4  query is a leading word of the core    → «НАПОЛЕОН АВГАНСКИЙ (ЦЕЛЫЙ)»
 *   5  anything else that still matched the filter
 *
 * Within a tier the caller keeps the SQL `ORDER BY name` ordering (stable sort).
 */
export function bareNameRank(name: string, query: string): number {
  const q = normalizeSearch(query);
  if (q === '') return 5;
  const { core, qualifier, isWhole } = parseProductName(name);
  const coreKey = normalizeSearch(core);

  if (coreKey === q) {
    if (isWhole) return 0;
    if (qualifier === '') return 1;
    // A portion qualifier (ПОЛОВИНА/КУСОК) ranks above a flavour variant.
    if (qualifier === 'половина' || qualifier === 'кусок' || qualifier === 'half' || qualifier === 'piece') {
      return 2;
    }
    return 3;
  }

  // Query is the FIRST word(s) of a longer core ("napoleon" ⊂ "napoleon afgan").
  const firstWordKey = normalizeSearch(core.split(' ')[0] ?? '');
  if (firstWordKey === q) return 4;

  return 5;
}
