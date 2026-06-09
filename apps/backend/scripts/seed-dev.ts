/**
 * Dev seed — minimal data so the frontend can log in and exercise M1-M3.
 *
 * LOCAL DEV ONLY. Idempotent: re-running upserts by natural keys (username,
 * name) and never duplicates rows.
 *
 * Seeds:
 *   - a `pm` super-admin user (login: pm / changeme123);
 *   - one location per chain link (raw_warehouse -> store) with a parent chain;
 *   - a manager user per non-pm location;
 *   - a handful of sample products (raw / semi / finished);
 *   - a starting stock row with min/max for the store, so the replenishment
 *     scan in M4 has data to act on;
 *   - a BOM for the finished product (Shokoladli tort = un + shakar + tuxum)
 *     so the engine can transition past CHECK_PRODUCTION_INPUT;
 *   - a starting raw-warehouse stock for every raw ingredient so the engine
 *     finds enough input to issue a production order.
 *
 * Usage:  npm run seed:dev    (from apps/backend)
 */
import bcrypt from 'bcryptjs';
import { query, closePool } from '../src/db/index.js';

/** Default password for every seeded account — CHANGE in any real environment. */
const SEED_PASSWORD = 'changeme123';
const BCRYPT_ROUNDS = 10;

type LocationType =
  | 'raw_warehouse'
  | 'production'
  | 'sex_storage'
  | 'supply' // deprecated synonym for sex_storage — kept for legacy fixtures
  | 'central_warehouse'
  | 'store';

type LocationSeed = {
  name: string;
  type: LocationType;
  parentName: string | null;
  managerRole:
    | 'raw_warehouse_manager'
    | 'production_manager'
    | 'supply_manager'
    | 'central_warehouse_manager'
    | 'store_manager';
};

// Chain (D7, 2026-05-28; + TZ §6 cream отдел): raw warehouse -> production root
// -> sex floors (Tort, Perojniy, Yarim Fabrika, Qaymoq) -> sex skladi (one per
// sex, type `sex_storage`) -> central warehouse -> store. Every sex has its own
// ready-batch buffer (`sex_storage`); the central warehouse parents to the Tort
// skladi so the M4 replenishment engine has an end-to-end path. The
// `supply_manager` role is reused as the manager of the sex_storage layer.
const LOCATIONS: LocationSeed[] = [
  { name: 'Mahsulotlar Ombori', type: 'raw_warehouse', parentName: null, managerRole: 'raw_warehouse_manager' },
  { name: 'Ishlab chiqarish sexi', type: 'production', parentName: 'Mahsulotlar Ombori', managerRole: 'production_manager' },
  { name: 'Tort sexi', type: 'production', parentName: 'Ishlab chiqarish sexi', managerRole: 'production_manager' },
  { name: 'Perojniy sexi', type: 'production', parentName: 'Ishlab chiqarish sexi', managerRole: 'production_manager' },
  { name: 'Yarim Fabrika sexi', type: 'production', parentName: 'Ishlab chiqarish sexi', managerRole: 'production_manager' },
  { name: 'Tort skladi', type: 'sex_storage', parentName: 'Tort sexi', managerRole: 'supply_manager' },
  { name: 'Perojniy skladi', type: 'sex_storage', parentName: 'Perojniy sexi', managerRole: 'supply_manager' },
  { name: 'Yarim Fabrika skladi', type: 'sex_storage', parentName: 'Yarim Fabrika sexi', managerRole: 'supply_manager' },
  // TZ §6 — the dedicated cream/krem отдел + its sex_storage buffer. The
  // structure itself is also seeded idempotently by migration 0060 (app-owned
  // config); listing them here gives the dev DB a manager + user_locations for
  // each (D6), exactly like every other sex. The cream product + flows live in
  // the migration. `upsertLocation` dedups by name, so this never duplicates
  // the migration's rows — whichever ran first wins.
  { name: 'Qaymoq sexi', type: 'production', parentName: 'Ishlab chiqarish sexi', managerRole: 'production_manager' },
  { name: 'Qaymoq skladi', type: 'sex_storage', parentName: 'Qaymoq sexi', managerRole: 'supply_manager' },
  { name: 'Markaziy Sklad', type: 'central_warehouse', parentName: 'Tort skladi', managerRole: 'central_warehouse_manager' },
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

/** Insert a user if the username is free; return the user id either way. */
async function upsertUser(
  name: string,
  username: string,
  role: string,
  locationId: number | null,
): Promise<number> {
  // `username` is the sole login handle (email was removed entirely). It must
  // satisfy chk_users_username_format (`^[a-z0-9._-]{3,32}$`).
  const existing = await query<{ id: number }>('SELECT id FROM users WHERE username = $1', [
    username,
  ]);
  let userId: number;
  if (existing.rows[0] !== undefined) {
    userId = existing.rows[0].id;
  } else {
    const hash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_ROUNDS);
    const { rows } = await query<{ id: number }>(
      `INSERT INTO users (name, username, password_hash, role, location_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, username, hash, role, locationId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Failed to insert user ${username}.`);
    }
    userId = row.id;
  }

  // Keep `user_locations` in sync with `users.location_id` (ADR-0012): the
  // authenticate middleware resolves assigned locations from `user_locations`,
  // NOT from `users.location_id`, so a scoped user with no primary row here is
  // locked out of its own location ("X-Active-Location is not assigned").
  // Idempotent — also back-fills users seeded before this sync was added.
  // `is_primary` is TRUE only when the user has no primary yet; otherwise the
  // row is a secondary attachment. This keeps the partial-unique invariant
  // (`uq_user_locations_primary` — one primary per user) intact even when the
  // user's existing primary points at a different location (e.g. a real
  // Poster-synced warehouse vs. this seed's placeholder).
  if (locationId !== null) {
    const primary = await query(
      'SELECT 1 FROM user_locations WHERE user_id = $1 AND is_primary = TRUE',
      [userId],
    );
    const isPrimary = primary.rows.length === 0;
    await query(
      `INSERT INTO user_locations (user_id, location_id, is_primary, assigned_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, location_id) DO NOTHING`,
      [userId, locationId, isPrimary],
    );
  }
  return userId;
}

/**
 * Resolve the canonical raw warehouse — the Poster-synced "Основной склад"
 * (poster_storage_id=2, ADR-0017). The dev seed also defines a placeholder
 * `raw_warehouse` ("Mahsulotlar Ombori") with no Poster link; on a
 * Poster-synced DB we must consolidate the whole replenishment chain onto the
 * REAL raw warehouse (the one that actually stocks ingredients), exactly like
 * the central-warehouse dedup. Returns null when no raw warehouse exists yet
 * (fresh DB before the placeholder is inserted).
 */
async function resolveCanonicalRawWarehouseId(): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM locations
      WHERE type = 'raw_warehouse'
      ORDER BY (poster_storage_id IS NOT NULL) DESC, id
      LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}

/**
 * Resolve the canonical central warehouse — the Poster singleton "Склад
 * Центральный" (poster_storage_id=8). Same dedup rule as the raw warehouse.
 */
async function resolveCanonicalCentralWarehouseId(): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM locations
      WHERE type = 'central_warehouse'
      ORDER BY (poster_storage_id IS NOT NULL) DESC, id
      LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}

/** Insert a location if its name is free; return the location id. */
async function upsertLocation(
  name: string,
  type: string,
  parentId: number | null,
): Promise<number> {
  // The central warehouse is a singleton owned by Poster ("Склад Центральный",
  // poster_storage_id=8). Reuse the existing Poster-synced row instead of
  // creating a second, placeholder central_warehouse ("Markaziy Sklad") — the
  // duplicate has no stock and only confuses the location switcher.
  if (type === 'central_warehouse') {
    const central = await resolveCanonicalCentralWarehouseId();
    if (central !== null) {
      return central;
    }
  }
  // The raw warehouse is likewise a Poster singleton ("Основной склад",
  // poster_storage_id=2, ADR-0017) that holds the real ingredient stock. Reuse
  // it instead of creating a second placeholder ("Mahsulotlar Ombori") so the
  // dev ingredient stock and the replenishment chain land on the warehouse that
  // actually stocks raws. On a fresh DB (no Poster sync) the placeholder is
  // created as before and becomes the canonical raw.
  if (type === 'raw_warehouse') {
    const raw = await resolveCanonicalRawWarehouseId();
    if (raw !== null) {
      return raw;
    }
  }
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

/**
 * Wire the location topology (`locations.parent_id`) so the replenishment
 * engine resolves the supply chain end-to-end. `resolveTopology` walks
 * `parent_id` UPWARD from the requester, so the chain must be:
 *
 *   store -> central_warehouse -> production hub -> raw_warehouse (root)
 *
 * Idempotent + id-stable: matches locations by TYPE and the canonical Poster
 * singletons (never volatile hardcoded ids), and is safe to re-run on every
 * seed. Rules (one company — single chain):
 *   1. every store.parent_id        = the canonical central warehouse
 *   2. central_warehouse.parent_id  = the main production hub
 *   3. main production hub.parent_id = the canonical raw warehouse
 *   4. every parentless production.parent_id = the canonical raw warehouse
 *   5. raw warehouses stay roots (parent_id stays NULL)
 *
 * The per-product production routing is `products.workshop_location_id`
 * (migration 0054); the central's parent chain is only walked to find the RAW
 * warehouse, so `central -> hub -> raw` is sufficient for raw resolution
 * regardless of which workshop a product is actually made in.
 */
async function wireTopology(
  locationIdByName: Map<string, number>,
): Promise<void> {
  const rawId = await resolveCanonicalRawWarehouseId();
  const centralId = await resolveCanonicalCentralWarehouseId();
  if (rawId === null || centralId === null) {
    console.warn('[seed-dev]   topology: missing raw/central warehouse — skipping wiring.');
    return;
  }

  // 5. Raw warehouses are roots — defensively clear any parent so a
  //    placeholder raw never points at the canonical one (which would break
  //    the chain walk).
  await query(`UPDATE locations SET parent_id = NULL WHERE type = 'raw_warehouse'`);

  // 3. Main production hub -> canonical raw. The hub is the seed-created
  //    "Ishlab chiqarish sexi" (it sits between the central warehouse and the
  //    raw warehouse). It must NOT point at the placeholder raw.
  const hubId = locationIdByName.get('Ishlab chiqarish sexi') ?? null;
  if (hubId !== null) {
    await query('UPDATE locations SET parent_id = $1 WHERE id = $2 AND id <> $1', [rawId, hubId]);
  }

  // 4. Every production location with NO parent (the Poster-synced workshops)
  //    -> canonical raw, so each workshop can resolve raw for its own pulls.
  //    The seed sex floors (Tort/Perojniy/Yarim) already parent to the hub and
  //    are left untouched (the hub resolves raw for them).
  await query(
    `UPDATE locations
        SET parent_id = $1
      WHERE type = 'production' AND parent_id IS NULL AND id <> $1`,
    [rawId],
  );

  // 2. Central warehouse -> production hub (so the central's chain reaches a
  //    production location AND the raw warehouse above it). Fall back to the
  //    canonical raw directly when no hub exists (degenerate dev DB).
  await query('UPDATE locations SET parent_id = $1 WHERE id = $2 AND id <> $1', [
    hubId ?? rawId,
    centralId,
  ]);

  // 1. Every store -> canonical central warehouse.
  await query(
    `UPDATE locations SET parent_id = $1 WHERE type = 'store' AND (parent_id IS DISTINCT FROM $1) AND id <> $1`,
    [centralId],
  );

  const counts = await query<{ type: string; total: string; wired: string }>(
    `SELECT type, count(*)::text AS total, count(parent_id)::text AS wired
       FROM locations GROUP BY type ORDER BY type`,
  );
  console.log(
    `[seed-dev]   topology wired: raw=${rawId} central=${centralId} hub=${hubId ?? '(none)'}`,
  );
  for (const c of counts.rows) {
    console.log(`[seed-dev]     ${c.type}: ${c.wired}/${c.total} have parent_id`);
  }
}

/**
 * Assign a `production_manager` to EVERY `type='production'` location that has
 * none yet (D6 — every location has its own manager). This covers the
 * Poster-synced workshops (`poster_workshop_id` set, e.g. 115 "Сомса отдел")
 * which are NOT in the static `LOCATIONS` array: without a manager the
 * central → production replenishment flow stalls there, because
 * `PATCH /api/production-orders/:id` requires the production_manager who OWNS
 * the order's location.
 *
 * The workshop names are Cyrillic, so the login (which must satisfy
 * `chk_users_username_format` = `^[a-z0-9._-]{2,32}$`) is derived from the
 * stable `poster_workshop_id` (`pm-ws-<id>`) and falls back to the location id
 * (`pm-ws-loc-<id>`) for the legacy seed children that have no Poster link.
 *
 * Idempotent:
 *   - the location set is queried at run time (anything already owning a
 *     production_manager via `user_locations` is excluded), so a re-seed is a
 *     no-op once every workshop has a manager;
 *   - `upsertUser` matches by username (never duplicates the account) and
 *     keeps `user_locations` in sync with `ON CONFLICT DO NOTHING`;
 *   - if a manager is already bound to the workshop it is reused — D6's
 *     one-manager-per-location is honoured, no second manager is created.
 */
async function seedWorkshopManagers(): Promise<void> {
  // Production locations with NO production_manager bound via user_locations.
  const { rows } = await query<{ id: number; name: string; poster_workshop_id: number | null }>(
    `SELECT l.id, l.name, l.poster_workshop_id
       FROM locations l
      WHERE l.type = 'production'::location_type
        AND NOT EXISTS (
          SELECT 1 FROM user_locations ul
          JOIN users u ON u.id = ul.user_id
          WHERE ul.location_id = l.id AND u.role = 'production_manager'
        )
      ORDER BY l.id`,
  );

  if (rows.length === 0) {
    console.log('[seed-dev]   workshop managers: every production location already has one.');
    return;
  }

  for (const loc of rows) {
    // Stable, ASCII-clean, predictable login. poster_workshop_id is the natural
    // key for Poster workshops; the legacy seed children fall back to loc id.
    const slug =
      loc.poster_workshop_id !== null
        ? `pm-ws-${loc.poster_workshop_id}`
        : `pm-ws-loc-${loc.id}`;
    const managerId = await upsertUser(
      `${loc.name} — boshliq`,
      slug,
      'production_manager',
      loc.id,
    );
    // Mirror onto locations.manager_user_id only when empty, so a workshop that
    // already names a manager (set elsewhere) is not silently overwritten.
    await query(
      'UPDATE locations SET manager_user_id = $1 WHERE id = $2 AND manager_user_id IS NULL',
      [managerId, loc.id],
    );
    console.log(
      `[seed-dev]   workshop manager: ${slug} / ${SEED_PASSWORD}  (${loc.name}, location ${loc.id})`,
    );
  }
}

async function main(): Promise<void> {
  console.log('[seed-dev] seeding development data...');

  // 1. PM super-admin (chain-wide, no location).
  const pmId = await upsertUser('Loyiha menejeri', 'pm', 'pm', null);
  console.log(`[seed-dev] pm user id=${pmId}  (login: pm / ${SEED_PASSWORD})`);

  // 2. Locations in chain order; each parent is created before its child.
  const locationIdByName = new Map<string, number>();
  for (const loc of LOCATIONS) {
    const parentId = loc.parentName === null ? null : locationIdByName.get(loc.parentName) ?? null;
    const id = await upsertLocation(loc.name, loc.type, parentId);
    locationIdByName.set(loc.name, id);
  }

  // 2b. Wire the replenishment topology (`parent_id`) idempotently. `upsertLocation`
  //     only sets parent_id on INSERT, so an already-seeded DB keeps stale/empty
  //     parents; this UPDATE-based pass re-asserts the whole chain on every run
  //     (store -> central -> production hub -> raw warehouse).
  await wireTopology(locationIdByName);

  // 3. One manager user per location, then attach as the location's manager.
  //    The username (login) must be unique per location: roles like
  //    supply_manager are now shared across 3 supply nodes (Tort / Perojniy /
  //    Yarim Fabrika), so role-only slugs would collapse all three managers
  //    into the same user. The role-slug counters below keep the first
  //    location in a role on the bare slug (e.g. `supply-manager` stays mapped
  //    to "Tort skladi") and append `-2`, `-3`, ... for the rest. The slug
  //    matches chk_users_username_format (`^[a-z0-9._-]{3,32}$`).
  const roleSlugCount = new Map<string, number>();
  for (const loc of LOCATIONS) {
    const locId = locationIdByName.get(loc.name);
    if (locId === undefined) {
      continue;
    }
    const slug = loc.managerRole.replace(/_/g, '-');
    const seen = roleSlugCount.get(slug) ?? 0;
    roleSlugCount.set(slug, seen + 1);
    const username = seen === 0 ? slug : `${slug}-${seen + 1}`;
    const managerId = await upsertUser(`${loc.name} — boshliq`, username, loc.managerRole, locId);
    await query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [managerId, locId]);
    console.log(`[seed-dev]   manager login: ${username} / ${SEED_PASSWORD}  (${loc.name})`);
  }

  // 3b. Assign a production_manager to EVERY remaining production workshop
  //     (D6) — chiefly the Poster-synced sexes (poster_workshop_id set) that
  //     are absent from the static LOCATIONS array. Without this, production
  //     orders raised at those workshops by the replenishment engine have no
  //     operator who can drive them new -> in_progress -> done.
  await seedWorkshopManagers();

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

  // 6. BOM for Shokoladli tort. One cake = 0.5 kg un + 0.3 kg shakar + 2 tuxum.
  //    Without a BOM the engine stalls at CHECK_PRODUCTION_INPUT because it
  //    cannot compute the input requirement (AC4.1 zero-config goal).
  const flourId = productIdBySku.get('RAW-FLOUR');
  const sugarId = productIdBySku.get('RAW-SUGAR');
  const eggId = productIdBySku.get('RAW-EGG');
  if (cakeId !== undefined && flourId !== undefined && sugarId !== undefined && eggId !== undefined) {
    for (const [componentId, qtyPerUnit] of [
      [flourId, 0.5],
      [sugarId, 0.3],
      [eggId, 2],
    ] as const) {
      await query(
        `INSERT INTO recipes (product_id, component_product_id, qty_per_unit)
         VALUES ($1, $2, $3)
         ON CONFLICT (product_id, component_product_id, stage) DO NOTHING`,
        [cakeId, componentId, qtyPerUnit],
      );
    }
  }

  // 7. Raw-warehouse opening stock — enough for the engine to advance past
  //    CHECK_PRODUCTION_INPUT into CREATE_PRODUCTION_ORDER without a manual
  //    purchase round. 200 of each is generous for dev.
  const rawWhId = locationIdByName.get('Mahsulotlar Ombori');
  if (rawWhId !== undefined) {
    const rawSeed: [number | undefined, number][] = [
      [flourId, 200],
      [sugarId, 200],
      [eggId, 200],
    ];
    for (const [productId, qty] of rawSeed) {
      if (productId === undefined) continue;
      await query(
        `INSERT INTO stock (location_id, product_id, qty, min_level, max_level)
         VALUES ($1, $2, $3, 0, 0)
         ON CONFLICT (location_id, product_id) DO NOTHING`,
        [rawWhId, productId, qty],
      );
    }
  }

  // 8. Sex-storage starter stock (canvas Bug 1 — migration 0020; renamed by D7).
  //    The three sex skladi are logical hand-off nodes (no Poster storage) so
  //    the leftover sync never seeds them. Without at least one stock row the
  //    ecosystem canvas renders them as "SKU yo'q" and downstream replenishment
  //    has no target. Yarim Fabrika skladi carries the semi (SEMI-SPONGE);
  //    Perojniy skladi carries the finished cake. qty=0 keeps the engine
  //    honest — it must produce.
  const yarimStorageId = locationIdByName.get('Yarim Fabrika skladi');
  const perojniyStorageId = locationIdByName.get('Perojniy skladi');
  const spongeId = productIdBySku.get('SEMI-SPONGE');
  if (yarimStorageId !== undefined && spongeId !== undefined) {
    await query(
      `INSERT INTO stock (location_id, product_id, qty, min_level, max_level)
       VALUES ($1, $2, 0, 0, 0)
       ON CONFLICT (location_id, product_id) DO NOTHING`,
      [yarimStorageId, spongeId],
    );
  }
  if (perojniyStorageId !== undefined && cakeId !== undefined) {
    await query(
      `INSERT INTO stock (location_id, product_id, qty, min_level, max_level)
       VALUES ($1, $2, 0, 0, 0)
       ON CONFLICT (location_id, product_id) DO NOTHING`,
      [perojniyStorageId, cakeId],
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
