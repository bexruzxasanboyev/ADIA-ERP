/**
 * Test fixtures — small builders for users, locations, products and stock,
 * plus JWT minting, so integration tests stay terse and readable.
 *
 * All builders run against a `TestDb` (the per-suite isolated schema).
 */
import bcrypt from 'bcryptjs';
import { signToken } from '../../src/auth/jwt.js';
import type { Role } from '../../src/auth/roles.js';
import type { TestDb } from './testDb.js';

export type SeededUser = {
  id: number;
  email: string;
  role: Role;
  locationId: number | null;
  /** A signed JWT for this user — ready for `Authorization: Bearer`. */
  token: string;
};

/** Insert a user with a known password and return it plus a signed token. */
export async function makeUser(
  db: TestDb,
  opts: { role: Role; locationId?: number | null; email?: string; password?: string },
): Promise<SeededUser> {
  const email = opts.email ?? `${opts.role}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const password = opts.password ?? 'password123';
  const locationId = opts.locationId ?? null;
  const hash = await bcrypt.hash(password, 6); // low rounds — tests favour speed.

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role, location_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [`Test ${opts.role}`, email, hash, opts.role, locationId],
  );
  const idRaw = rows[0]?.id;
  if (idRaw === undefined) {
    throw new Error('makeUser: insert returned no id.');
  }
  // BIGINT columns arrive as strings from pg — coerce to a number id.
  const id = Number(idRaw);
  const token = signToken({ userId: id, role: opts.role, locationId });
  return { id, email, role: opts.role, locationId, token };
}

/** Insert a location and return its id. */
export async function makeLocation(
  db: TestDb,
  opts: {
    name?: string;
    type?: 'raw_warehouse' | 'production' | 'supply' | 'central_warehouse' | 'store';
    parentId?: number | null;
  } = {},
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO locations (name, type, parent_id) VALUES ($1, $2, $3) RETURNING id`,
    [
      opts.name ?? `Location ${Math.random().toString(36).slice(2, 8)}`,
      opts.type ?? 'store',
      opts.parentId ?? null,
    ],
  );
  const idRaw = rows[0]?.id;
  if (idRaw === undefined) {
    throw new Error('makeLocation: insert returned no id.');
  }
  return Number(idRaw);
}

/** Insert a product and return its id. */
export async function makeProduct(
  db: TestDb,
  opts: {
    name?: string;
    type?: 'raw' | 'semi' | 'finished';
    unit?: 'kg' | 'l' | 'pcs';
    sku?: string;
  } = {},
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO products (name, type, unit, sku) VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      opts.name ?? `Product ${Math.random().toString(36).slice(2, 8)}`,
      opts.type ?? 'finished',
      opts.unit ?? 'pcs',
      opts.sku ?? `SKU-${Math.random().toString(36).slice(2, 10)}`,
    ],
  );
  const idRaw = rows[0]?.id;
  if (idRaw === undefined) {
    throw new Error('makeProduct: insert returned no id.');
  }
  return Number(idRaw);
}

/** Set (upsert) a stock row for (location, product). */
export async function setStock(
  db: TestDb,
  opts: {
    locationId: number;
    productId: number;
    qty: number;
    minLevel?: number;
    maxLevel?: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO stock (location_id, product_id, qty, min_level, max_level)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (location_id, product_id)
     DO UPDATE SET qty = EXCLUDED.qty, min_level = EXCLUDED.min_level,
                   max_level = EXCLUDED.max_level`,
    [opts.locationId, opts.productId, opts.qty, opts.minLevel ?? 0, opts.maxLevel ?? 0],
  );
}

/** Read the current qty for (location, product); `null` when no row exists. */
export async function getQty(
  db: TestDb,
  locationId: number,
  productId: number,
): Promise<number | null> {
  const { rows } = await db.query<{ qty: string }>(
    'SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2',
    [locationId, productId],
  );
  const raw = rows[0]?.qty;
  return raw === undefined ? null : Number(raw);
}
