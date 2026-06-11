/**
 * AI recipe-yield estimation (TZ-3, owner decision 2026-06-05: "AI estimate +
 * manager confirm").
 *
 * Poster gives no batch yield for finished goods, so a batch recipe (e.g.
 * ПЕЧЕНЬЕ: 1 kg chocolate "per dona") imports as if it were per-1-piece. This
 * asks Vertex to read the recipe and estimate how many finished pieces ONE full
 * recipe makes; the production manager then confirms/edits via
 * `PATCH /api/products/:id/recipe-yield`. The estimate only SEEDS the value.
 */
import { type Content } from '@google/genai';
import {
  defaultVertexClient,
  isVertexEnabled,
  type VertexClient,
} from '../integrations/vertex/client.js';
import { query } from '../db/index.js';

export interface RecipeYieldEstimate {
  readonly product_id: number;
  readonly name: string;
  readonly estimated_yield: number;
}

/**
 * Estimate how many finished pieces one recipe of `productId` makes. Returns
 * null when Vertex is disabled, the product/recipe is missing, or the model
 * gives no usable number. Never throws on a bad model reply — the caller keeps
 * the existing yield (default 1).
 */
export async function estimateRecipeYield(
  productId: number,
  client: VertexClient = defaultVertexClient,
): Promise<number | null> {
  if (!client.enabled && !isVertexEnabled()) return null;

  const { rows: prodRows } = await query<{ name: string }>(
    `SELECT name FROM products WHERE id = $1`,
    [productId],
  );
  const product = prodRows[0];
  if (product === undefined) return null;

  const { rows: comps } = await query<{
    name: string;
    qty: string | number;
    unit: string;
  }>(
    `SELECT p.name, r.qty_per_unit AS qty, p.unit::text AS unit
       FROM recipes r JOIN products p ON p.id = r.component_product_id
      WHERE r.product_id = $1
      ORDER BY r.qty_per_unit DESC`,
    [productId],
  );
  if (comps.length === 0) return null;

  const lines = comps
    .map((c) => `- ${c.name}: ${Number(c.qty)} ${c.unit}`)
    .join('\n');
  const prompt =
    `Quyida non/qandolat sexining "${product.name}" mahsuloti retsepti keltirilgan. ` +
    `Bu retsept tizimда "1 dona" deb saqlangan, LEKIN aslida bu bir marta ` +
    `tayyorlanadigan to'liq retsept bo'lishi mumkin (partiya). Retseptdagi ` +
    `miqdorlarga qarab, bu retsept necha DONA tayyor "${product.name}" ` +
    `chiqarishini bahola.\n\nRetsept (komponent: miqdor birlik):\n${lines}\n\n` +
    `FAQAT bitta butun son bilan javob ber (masalan: 30). Boshqa hech narsa yozma. ` +
    `Agar retsept allaqachon 1 dona uchun ko'rinsa, 1 deb javob ber.`;

  const contents: Content[] = [{ role: 'user', parts: [{ text: prompt }] }];
  const response = await client.generate({
    systemInstruction:
      'Sen non/qandolat ishlab chiqarish texnologisisan. Retsept miqdorlaridan ' +
      'bir retsept necha dona tayyor mahsulot chiqarishini baholaysan. FAQAT son qaytar.',
    contents,
    tools: [],
  });
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p) => (typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
    .join(' ');
  const match = text.match(/\d+(?:[.,]\d+)?/);
  if (match === null) return null;
  const n = Number(match[0].replace(',', '.'));
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.round(n);
}

/**
 * Candidate finished products whose recipe still looks batch-sized: yield is
 * still the default 1 AND the total weight/volume of one "piece" exceeds
 * `thresholdKg` (a single pastry never needs >1.5 kg of raw). These are the
 * rows worth an AI estimate + manager review.
 */
export async function findBatchYieldCandidates(
  thresholdKg = 1.5,
): Promise<{ product_id: number; name: string; total_kg: number }[]> {
  const { rows } = await query<{ id: number; name: string; total_kg: string }>(
    `SELECT p.id, p.name, SUM(r.qty_per_unit) FILTER (WHERE c.unit IN ('kg','l')) AS total_kg
       FROM products p
       JOIN recipes r ON r.product_id = p.id
       JOIN products c ON c.id = r.component_product_id
      WHERE p.type = 'finished' AND p.recipe_yield = 1
      GROUP BY p.id, p.name
     HAVING SUM(r.qty_per_unit) FILTER (WHERE c.unit IN ('kg','l')) > $1
      ORDER BY 3 DESC`,
    [thresholdKg],
  );
  return rows.map((r) => ({
    product_id: Number(r.id),
    name: r.name,
    total_kg: Number(r.total_kg),
  }));
}
