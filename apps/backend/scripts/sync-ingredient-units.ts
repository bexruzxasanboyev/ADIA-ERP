/**
 * One-off DEV data fix — sync ingredient-backed `products.unit` from Poster's
 * authoritative `menu.getIngredients` `ingredient_unit`.
 *
 * Authoritative source = Poster `ingredient_unit` (NOT product names). We
 * normalise Poster's raw unit strings to the ADIA `unit_type` enum
 * (`'kg' | 'l' | 'pcs'`) and UPDATE only ingredient-backed rows
 * (`poster_ingredient_id IS NOT NULL`) whose current `unit` MISMATCHES.
 *
 * Normalisation:
 *   kg / g / гр / г            -> kg   (weight)
 *   l  / ml / мл / л           -> l    (volume)
 *   p  / pcs / шт / dona       -> pcs  (piece)
 *
 * Phases (env `APPLY`):
 *   APPLY unset/false -> DIAGNOSE only (no writes).
 *   APPLY=1           -> UPDATE mismatched rows in ONE transaction.
 *
 * SAFETY: refuses to run unless DATABASE_URL points at a "dev" database.
 * Usage:  npx tsx scripts/sync-ingredient-units.ts          (diagnose)
 *         APPLY=1 npx tsx scripts/sync-ingredient-units.ts  (apply)
 */
import { withTransaction, query, closePool } from '../src/db/index.js';
import { loadConfig } from '../src/config/index.js';
import { createPosterClientFromConfig } from '../src/integrations/poster/client.js';

type AdiaUnit = 'kg' | 'l' | 'pcs';

/** Normalise a raw Poster `ingredient_unit` to the ADIA enum, or null if unknown. */
function normalizeUnit(raw: string): AdiaUnit | null {
  const u = raw.trim().toLowerCase();
  switch (u) {
    // weight
    case 'kg':
    case 'кг':
    case 'g':
    case 'гр':
    case 'г':
    case 'gr':
      return 'kg';
    // volume
    case 'l':
    case 'л':
    case 'ml':
    case 'мл':
      return 'l';
    // piece
    case 'p':
    case 'pcs':
    case 'pc':
    case 'шт':
    case 'дона':
    case 'dona':
    case 'ед':
      return 'pcs';
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const dbUrl = cfg.databaseUrl ?? process.env.DATABASE_URL ?? '';
  if (!/dev/i.test(dbUrl)) {
    throw new Error(`Refusing to run: DATABASE_URL does not look like a dev DB (${dbUrl}).`);
  }
  const apply = process.env.APPLY === '1' || process.env.APPLY === 'true';

  const poster = createPosterClientFromConfig();
  console.log('Fetching menu.getIngredients ...');
  const ingredients = await poster.getIngredients();
  console.log(`Poster returned ${ingredients.length} ingredients.`);

  // --- STEP 1: build map ingredient_id -> {raw, normalized} ---
  const map = new Map<number, { raw: string; norm: AdiaUnit | null }>();
  const rawCounts = new Map<string, number>();
  for (const ing of ingredients) {
    const id = Number(ing.ingredient_id);
    const raw = String(ing.ingredient_unit ?? '');
    rawCounts.set(raw, (rawCounts.get(raw) ?? 0) + 1);
    map.set(id, { raw, norm: normalizeUnit(raw) });
  }

  console.log('\n=== STEP 1: distinct raw ingredient_unit values seen ===');
  const distinct = [...rawCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [raw, n] of distinct) {
    const norm = normalizeUnit(raw);
    console.log(
      `  raw="${raw}" (${n} ingredients)  ->  ${norm ?? 'UNMAPPED (!!)'}`,
    );
  }

  // --- STEP 2: diagnose against products ---
  const products = await query<{
    id: string;
    name: string;
    type: string;
    unit: AdiaUnit;
    poster_ingredient_id: number;
  }>(
    `SELECT id, name, type, unit, poster_ingredient_id
       FROM products
      WHERE poster_ingredient_id IS NOT NULL
      ORDER BY type, id`,
  );

  let matched = 0;
  let notFound = 0;
  let unmapped = 0;
  const mismatches: Array<{
    id: string;
    name: string;
    type: string;
    from: AdiaUnit;
    to: AdiaUnit;
  }> = [];

  for (const p of products.rows) {
    const entry = map.get(p.poster_ingredient_id);
    if (entry === undefined) {
      notFound += 1;
      continue;
    }
    if (entry.norm === null) {
      unmapped += 1;
      console.log(
        `  UNMAPPED raw unit for product id=${p.id} "${p.name}" ingredient_id=${p.poster_ingredient_id} raw="${entry.raw}"`,
      );
      continue;
    }
    if (entry.norm === p.unit) {
      matched += 1;
    } else {
      mismatches.push({ id: p.id, name: p.name, type: p.type, from: p.unit, to: entry.norm });
    }
  }

  console.log('\n=== STEP 2: diagnosis ===');
  console.log(`  ingredient-backed products:        ${products.rows.length}`);
  console.log(`  already match:                     ${matched}`);
  console.log(`  NOT found in Poster response:      ${notFound} (skipped)`);
  console.log(`  unmapped raw unit:                 ${unmapped} (skipped)`);
  console.log(`  MISMATCH (will update):            ${mismatches.length}`);

  const grouped = new Map<string, number>();
  for (const m of mismatches) {
    const k = `${m.from} -> ${m.to}`;
    grouped.set(k, (grouped.get(k) ?? 0) + 1);
  }
  console.log('\n  mismatches grouped by (from -> to):');
  for (const [k, n] of [...grouped.entries()].sort()) {
    console.log(`    ${k}: ${n}`);
  }

  // Highlight semi/raw flips (most important).
  const semiRawFlips = mismatches.filter((m) => m.type === 'semi' || m.type === 'raw');
  console.log(`\n  semi/raw flips (${semiRawFlips.length}) — sample (up to 25):`);
  for (const m of semiRawFlips.slice(0, 25)) {
    console.log(`    [${m.type}] id=${m.id} "${m.name}"  ${m.from} -> ${m.to}`);
  }
  if (mismatches.length > 0) {
    console.log('\n  general sample (up to 15):');
    for (const m of mismatches.slice(0, 15)) {
      console.log(`    [${m.type}] id=${m.id} "${m.name}"  ${m.from} -> ${m.to}`);
    }
  }

  // --- STEP 3: apply ---
  if (!apply) {
    console.log('\n(DIAGNOSE only — set APPLY=1 to write.)');
    return;
  }
  if (mismatches.length === 0) {
    console.log('\nNothing to update.');
    return;
  }

  console.log('\n=== STEP 3: applying updates in ONE transaction ===');
  const perPair = new Map<string, number>();
  await withTransaction(async (tx) => {
    for (const m of mismatches) {
      await tx.query(`UPDATE products SET unit = $1::unit_type, updated_at = now() WHERE id = $2`, [
        m.to,
        m.id,
      ]);
      const k = `${m.from} -> ${m.to}`;
      perPair.set(k, (perPair.get(k) ?? 0) + 1);
    }
  });
  console.log('  updated per (from -> to):');
  for (const [k, n] of [...perPair.entries()].sort()) {
    console.log(`    ${k}: ${n}`);
  }
  console.log(`  total updated: ${mismatches.length}`);
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
