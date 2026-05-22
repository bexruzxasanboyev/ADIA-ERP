/**
 * Dev seed — minimal data so the frontend can log in and exercise M1-M3.
 *
 * LOCAL DEV ONLY. Idempotent: re-running upserts by natural keys (email, name)
 * and never duplicates rows.
 *
 * Seeds:
 *   - a `pm` super-admin user (login: pm@adia.local / changeme123);
 *   - one location per chain link (raw_warehouse -> store) with a parent chain;
 *   - a manager user per non-pm location;
 *   - a handful of sample products (raw / semi / finished);
 *   - a starting stock row with min/max for the store, so the replenishment
 *     scan in M4 has data to act on.
 *
 * Usage:  npm run seed:dev    (from apps/api)
 */
import bcrypt from 'bcryptjs';
import { query, closePool } from '../src/db/index.js';

/** Default password for every seeded account — CHANGE in any real environment. */
const SEED_PASSWORD = 'changeme123';
const BCRYPT_ROUNDS = 10;

type LocationSeed = {
  name: string;
  type: 'raw_warehouse' | 'production' | 'supply' | 'central_warehouse' | 'store';
  parentName: string | null;
  managerRole:
    | 'raw_warehouse_manager'
    | 'production_manager'
    | 'supply_manager'
    | 'central_warehouse_manager'
    | 'store_manager';
};

// Chain: raw warehouse -> production -> supply -> central warehouse -> store.
const LOCATIONS: LocationSeed[] = [
  { name: 'Mahsulotlar Ombori', type: 'raw_warehouse', parentName: null, managerRole: 'raw_warehouse_manager' },
  { name: 'Ishlab chiqarish sexi', type: 'production', parentName: 'Mahsulotlar Ombori', managerRole: 'production_manager' },
  { name: 'Ta\'minot — Tort', type: 'supply', parentName: 'Ishlab chiqarish sexi', managerRole: 'supply_manager' },
  { name: 'Markaziy Sklad', type: 'central_warehouse', parentName: 'Ta\'minot — Tort', managerRole: 'central_warehouse_manager' },
  { name: 'Do\'kon 1', type: 'store', parentName: 'Markaziy Sklad', managerRole: 'store_manager' },
];

type ProductSeed = {
  name: string;
  type: 'raw' | 'semi' | 'finished';
  unit: 'kg' | 'l' | 'pcs';
  sku: string;
};

const PRODUCTS: ProductSeed[] = [
  { name: 'Un (oliy nav)', type: 'raw', unit: 'kg', sku: 'RAW-FLOUR' },
  { name: 'Shakar', type: 'raw', unit: 'kg', sku: 'RAW-SUGAR' },
  { name: 'Tuxum', type: 'raw', unit: 'pcs', sku: 'RAW-EGG' },
  { name: 'Biskvit zagotovka', type: 'semi', unit: 'pcs', sku: 'SEMI-SPONGE' },
  { name: 'Shokoladli tort', type: 'finished', unit: 'pcs', sku: 'FIN-CHOCO-CAKE' },
];

/** Insert a user if the email is free; return the user id either way. */
async function upsertUser(
  name: string,
  email: string,
  role: string,
  locationId: number | null,
): Promise<number> {
  const existing = await query<{ id: number }>('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows[0] !== undefined) {
    return existing.rows[0].id;
  }
  const hash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_ROUNDS);
  const { rows } = await query<{ id: number }>(
    `INSERT INTO users (name, email, password_hash, role, location_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, email, hash, role, locationId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Failed to insert user ${email}.`);
  }
  return row.id;
}

/** Insert a location if its name is free; return the location id. */
async function upsertLocation(
  name: string,
  type: string,
  parentId: number | null,
): Promise<number> {
  const existing = await query<{ id: number }>('SELECT id FROM locations WHERE name = $1', [name]);
  if (existing.rows[0] !== undefined) {
    return existing.rows[0].id;
  }
  const { rows } = await query<{ id: number }>(
    `INSERT INTO locations (name, type, parent_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, type, parentId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Failed to insert location ${name}.`);
  }
  return row.id;
}

/** Insert a product if its SKU is free; return the product id. */
async function upsertProduct(p: ProductSeed): Promise<number> {
  const existing = await query<{ id: number }>('SELECT id FROM products WHERE sku = $1', [p.sku]);
  if (existing.rows[0] !== undefined) {
    return existing.rows[0].id;
  }
  const { rows } = await query<{ id: number }>(
    `INSERT INTO products (name, type, unit, sku) VALUES ($1, $2, $3, $4) RETURNING id`,
    [p.name, p.type, p.unit, p.sku],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Failed to insert product ${p.sku}.`);
  }
  return row.id;
}

async function main(): Promise<void> {
  console.log('[seed-dev] seeding development data...');

  // 1. PM super-admin (chain-wide, no location).
  const pmId = await upsertUser('Loyiha menejeri', 'pm@adia.local', 'pm', null);
  console.log(`[seed-dev] pm user id=${pmId}  (login: pm@adia.local / ${SEED_PASSWORD})`);

  // 2. Locations in chain order; each parent is created before its child.
  const locationIdByName = new Map<string, number>();
  for (const loc of LOCATIONS) {
    const parentId = loc.parentName === null ? null : locationIdByName.get(loc.parentName) ?? null;
    const id = await upsertLocation(loc.name, loc.type, parentId);
    locationIdByName.set(loc.name, id);
  }

  // 3. One manager user per location, then attach as the location's manager.
  for (const loc of LOCATIONS) {
    const locId = locationIdByName.get(loc.name);
    if (locId === undefined) {
      continue;
    }
    const slug = loc.managerRole.replace(/_/g, '-');
    const email = `${slug}@adia.local`;
    const managerId = await upsertUser(`${loc.name} — boshliq`, email, loc.managerRole, locId);
    await query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [managerId, locId]);
  }

  // 4. Products.
  const productIdBySku = new Map<string, number>();
  for (const p of PRODUCTS) {
    productIdBySku.set(p.sku, await upsertProduct(p));
  }

  // 5. A starting stock row for the store — qty below min so M4 has work to do.
  const storeId = locationIdByName.get("Do'kon 1");
  const cakeId = productIdBySku.get('FIN-CHOCO-CAKE');
  if (storeId !== undefined && cakeId !== undefined) {
    await query(
      `INSERT INTO stock (location_id, product_id, qty, min_level, max_level)
       VALUES ($1, $2, 2, 5, 20)
       ON CONFLICT (location_id, product_id) DO NOTHING`,
      [storeId, cakeId],
    );
  }

  console.log('[seed-dev] done.');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('[seed-dev] failed:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
