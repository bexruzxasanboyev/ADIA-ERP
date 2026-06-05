import type { RecipeNode, RecipeStage } from './types';

/**
 * EPIC 1.5 — group a recipe (BOM) into hamir / krem / bezak sections.
 *
 * Poster does not carry a usable stage on its recipe rows (every row syncs
 * as `base`), so we infer the stage from the component NAME with a keyword
 * heuristic. This matches the owner's "AI nomdan kategoriya" intent: a
 * manager reading a cake recipe sees the dough, the cream and the decoration
 * as distinct blocks instead of one flat list.
 *
 * The match is deliberately ordered decoration → cream → dough so the more
 * specific buckets win when a name could plausibly fall in two (e.g. a
 * chocolate glaze is decoration, not cream). Latin + Cyrillic spellings are
 * both covered because Poster names are mostly Russian. Anything unmatched
 * falls back to `other` ("Boshqa").
 */

const DECORATION_KEYWORDS = [
  'dekor', 'декор', 'glazur', 'глазур', 'posyp', 'посып', 'topping', 'топпинг',
  'mastik', 'мастик', 'marzipan', 'марципан', 'sve', 'свеч', 'candle',
  'ukrash', 'украш', 'bezak', 'konfet', 'конфет', 'figur', 'фигур',
  'shokoladka', 'шоколадка', 'gel', 'гель', 'kraska', 'краск', 'blest', 'блёст', 'блест',
];

const CREAM_KEYWORDS = [
  'krem', 'крем', 'cream', 'slivk', 'сливк', 'smetan', 'сметан', 'maslo',
  'масло', 'sariyog', 'sgush', 'сгущ', 'ganash', 'ганаш', 'mus', 'мусс',
  'tvorog', 'творог', 'syr', 'сыр', 'cheese', 'kastard', 'кастард',
  'nachink', 'начинк', 'jem', 'джем', 'povidl', 'повидл', 'confitur', 'конфитюр',
];

const DOUGH_KEYWORDS = [
  'muk', 'мук', 'flour', 'hamir', 'хамир', 'test', 'тест', 'dough', 'drozh',
  'дрожж', 'yeast', 'sahar', 'сахар', 'shakar', 'sugar', 'yayts', 'яйц',
  'tuxum', 'tuxm', 'egg', 'sol', 'соль', 'salt', 'voda', 'вода', 'water',
  'sod', 'сод', 'razryhl', 'разрыхл', 'krahmal', 'крахмал', 'biskvit',
  'бисквит', 'korzh', 'корж', 'pesochn', 'песочн', 'sloen', 'слоён', 'слоен',
];

function matches(haystack: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => haystack.includes(k));
}

/**
 * Whole-word terms that are too short to be safe substring matches (they would
 * over-match inside unrelated words). "un" = Uzbek flour — a core dough
 * ingredient — must NOT match inside "тунец"/"кунжут", so it is checked with a
 * word boundary instead of `includes`.
 */
const DOUGH_WORD_RE = /\b(un|tuz|sol)\b/;

/** Infer a recipe stage from a component name (case/diacritic-folded). */
export function classifyRecipeStage(name: string): RecipeStage {
  const h = name.toLowerCase();
  if (matches(h, DECORATION_KEYWORDS)) return 'decoration';
  if (matches(h, CREAM_KEYWORDS)) return 'cream';
  if (matches(h, DOUGH_KEYWORDS) || DOUGH_WORD_RE.test(h)) return 'dough';
  return 'other';
}

export interface RecipeStageGroup {
  stage: RecipeStage;
  nodes: RecipeNode[];
  /** Sum of the group's resolved costs, or null when none are known. */
  subtotal: number | null;
}

/**
 * Partition the TOP-LEVEL recipe nodes into stage groups, preserving the
 * canonical hamir → krem → bezak → boshqa order. Empty groups are dropped.
 * The grouping is intentionally shallow (top level only) — nested sub-recipe
 * cards still render in depth-first order inside their parent's group.
 */
export function groupRecipeByStage(
  tree: readonly RecipeNode[],
  order: readonly RecipeStage[],
): RecipeStageGroup[] {
  const byStage = new Map<RecipeStage, RecipeNode[]>();
  for (const node of tree) {
    const stage = classifyRecipeStage(node.name);
    const bucket = byStage.get(stage);
    if (bucket) bucket.push(node);
    else byStage.set(stage, [node]);
  }

  return order
    .filter((stage) => byStage.has(stage))
    .map((stage) => {
      const nodes = byStage.get(stage) ?? [];
      let subtotal: number | null = null;
      for (const n of nodes) {
        // The stage subtotal is the sum of each line's CONTRIBUTION to the
        // recipe (line_cost = qty × unit_cost), NOT the component's per-unit
        // cost (total_cost) — otherwise a cheap pinch of a pricey raw inflates
        // the section to that raw's per-kg price.
        if (n.line_cost !== null && n.line_cost !== undefined) {
          subtotal = (subtotal ?? 0) + n.line_cost;
        }
      }
      return { stage, nodes, subtotal };
    });
}
