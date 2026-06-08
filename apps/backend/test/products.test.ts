/**
 * M2 — Products & Recipes integration tests (spec section 4.3).
 *
 * Covers: product create/list with RBAC, the BOM full-replace endpoint, and
 * AC2.2 — a BOM must not create a cycle (direct self-reference or a deep
 * A -> B -> A loop).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser, makeProduct, makeLocation } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('products', () => {
  it('pm can create a product and filter the list by type', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const created = await request(ctx.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Flour', type: 'raw', unit: 'kg', sku: 'P-FLOUR' });
    expect(created.status).toBe(201);
    expect(created.body.product).toMatchObject({ name: 'Flour', type: 'raw' });

    await request(ctx.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Cake', type: 'finished', unit: 'pcs', sku: 'P-CAKE' });

    const rawOnly = await request(ctx.app)
      .get('/api/products?type=raw')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(rawOnly.status).toBe(200);
    expect(Array.isArray(rawOnly.body)).toBe(true);
    expect((rawOnly.body as { type: string }[]).every((p) => p.type === 'raw')).toBe(true);
  });

  it('EPIC 1.2 — ?search= matches translit (Latin query finds Cyrillic name)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const sku = `SRCH-${Math.random().toString(36).slice(2, 8)}`;
    await request(ctx.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Шоколад тёмный', type: 'raw', unit: 'kg', sku });

    const latin = await request(ctx.app)
      .get('/api/products?search=shokolad')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(latin.status).toBe(200);
    expect(
      (latin.body as { name: string }[]).some((p) => p.name === 'Шоколад тёмный'),
    ).toBe(true);

    // A non-matching query excludes it.
    const miss = await request(ctx.app)
      .get('/api/products?search=napoleon')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(
      (miss.body as { name: string }[]).some((p) => p.name === 'Шоколад тёмный'),
    ).toBe(false);
  });

  it('EPIC 1.3 — list rows carry smart category + effective_type', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const created = await request(ctx.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Г/П Торт Медовик', type: 'semi', unit: 'pcs' });
    expect(created.status).toBe(201);
    // Even on create the smart fields are present.
    expect(created.body.product.category).toBe('cake');
    expect(created.body.product.effective_type).toBe('finished');

    const list = await request(ctx.app)
      .get('/api/products')
      .set('Authorization', `Bearer ${pm.token}`);
    const row = (list.body as { name: string; category: string; effective_type: string }[]).find(
      (p) => p.name === 'Г/П Торт Медовик',
    );
    expect(row).toBeDefined();
    expect(row?.category).toBe('cake');
    expect(row?.effective_type).toBe('finished');
  });

  it('list rows expose the real Poster category as poster_category {id,name}', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });

    // A real Poster category (mirrors what syncCategories writes).
    const cat = await ctx.db.query<{ id: string }>(
      `INSERT INTO categories (poster_category_id, name)
       VALUES ($1, $2) RETURNING id`,
      [990001, 'Пирожные'],
    );
    const categoryId = Number(cat.rows[0]?.id);

    // A product linked to that category, plus one with NO category.
    const linkedName = `Эклер ${Math.random().toString(36).slice(2, 8)}`;
    await ctx.db.query(
      `INSERT INTO products (name, type, unit, category_id) VALUES ($1, 'finished', 'pcs', $2)`,
      [linkedName, categoryId],
    );
    const orphanName = `Мука ${Math.random().toString(36).slice(2, 8)}`;
    await ctx.db.query(`INSERT INTO products (name, type, unit) VALUES ($1, 'raw', 'kg')`, [
      orphanName,
    ]);

    const list = await request(ctx.app)
      .get('/api/products')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(list.status).toBe(200);

    type Row = { name: string; poster_category: { id: number; name: string } | null };
    const linked = (list.body as Row[]).find((p) => p.name === linkedName);
    expect(linked).toBeDefined();
    expect(linked?.poster_category).toEqual({ id: categoryId, name: 'Пирожные' });

    const orphan = (list.body as Row[]).find((p) => p.name === orphanName);
    expect(orphan).toBeDefined();
    expect(orphan?.poster_category).toBeNull();
  });

  it('list rows expose has_recipe: true for products with recipe rows, false otherwise', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const withRecipe = await makeProduct(ctx.db, { type: 'finished' });
    const withoutRecipe = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw' });

    await request(ctx.app)
      .put(`/api/products/${withRecipe}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: flour, qty_per_unit: 1 }] });

    const list = await request(ctx.app)
      .get('/api/products')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(list.status).toBe(200);

    type Row = { id: number; has_recipe: boolean };
    const rows = list.body as Row[];
    const yes = rows.find((p) => Number(p.id) === withRecipe);
    const no = rows.find((p) => Number(p.id) === withoutRecipe);
    expect(yes).toBeDefined();
    expect(yes?.has_recipe).toBe(true);
    expect(no).toBeDefined();
    expect(no?.has_recipe).toBe(false);
  });

  it('a store manager cannot create a product (403)', async () => {
    const mgr = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: await makeLocation(ctx.db),
    });
    const res = await request(ctx.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ name: 'X', type: 'raw', unit: 'kg' });
    expect(res.status).toBe(403);
  });
});

describe('product workshop (sex) assignment', () => {
  // A unique Poster workshop_id per call — the partial UNIQUE index on
  // locations.poster_workshop_id would otherwise collide within the suite.
  let workshopSeq = 700000;
  const nextWorkshopId = (): number => ++workshopSeq;

  it('assigns a canonical Poster workshop → 200 + workshop {id,name}', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const sexName = `Sex Tort ${Math.random().toString(36).slice(2, 6)}`;
    const sexId = await makeLocation(ctx.db, {
      type: 'production',
      name: sexName,
      posterWorkshopId: nextWorkshopId(),
    });

    const res = await request(ctx.app)
      .patch(`/api/products/${product}/workshop`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ workshop_location_id: sexId });
    expect(res.status).toBe(200);
    expect(res.body.workshop).toEqual({ id: sexId, name: sexName });

    // The list now reflects the assignment (same {id,name} shape).
    const list = await request(ctx.app)
      .get('/api/products')
      .set('Authorization', `Bearer ${pm.token}`);
    const row = (list.body as { id: number; workshop: { id: number; name: string } | null }[]).find(
      (p) => Number(p.id) === product,
    );
    expect(row?.workshop).toEqual({ id: sexId, name: sexName });
  });

  it('rejects a non-production location (store) with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const storeId = await makeLocation(ctx.db, { type: 'store' });

    const res = await request(ctx.app)
      .patch(`/api/products/${product}/workshop`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ workshop_location_id: storeId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a LEGACY production row (poster_workshop_id NULL) with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    // type='production' but NO Poster workshop_id — a legacy stock-bearing row,
    // not one of the 12 canonical workshops. Must be rejected.
    const legacyId = await makeLocation(ctx.db, { type: 'production' });

    const res = await request(ctx.app)
      .patch(`/api/products/${product}/workshop`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ workshop_location_id: legacyId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('clears the assignment with null → 200 + workshop null', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const sexId = await makeLocation(ctx.db, {
      type: 'production',
      posterWorkshopId: nextWorkshopId(),
    });

    // Assign first, then clear.
    await request(ctx.app)
      .patch(`/api/products/${product}/workshop`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ workshop_location_id: sexId });

    const cleared = await request(ctx.app)
      .patch(`/api/products/${product}/workshop`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ workshop_location_id: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.workshop).toBeNull();
  });

  it('production_manager can assign a workshop too', async () => {
    const pmgr = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: await makeLocation(ctx.db, { type: 'production' }),
    });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const sexId = await makeLocation(ctx.db, {
      type: 'production',
      posterWorkshopId: nextWorkshopId(),
    });

    const res = await request(ctx.app)
      .patch(`/api/products/${product}/workshop`)
      .set('Authorization', `Bearer ${pmgr.token}`)
      .send({ workshop_location_id: sexId });
    expect(res.status).toBe(200);
    expect(res.body.workshop?.id).toBe(sexId);
  });
});

describe('GET /api/products/workshops', () => {
  let workshopSeq = 800000;
  const nextWorkshopId = (): number => ++workshopSeq;

  it('returns only canonical Poster workshops as {id,name} ordered by name', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    // Two canonical workshops + one legacy production row + one store.
    const wbName = `WS Beta ${Math.random().toString(36).slice(2, 6)}`;
    const waName = `WS Alpha ${Math.random().toString(36).slice(2, 6)}`;
    const wb = await makeLocation(ctx.db, {
      type: 'production',
      name: wbName,
      posterWorkshopId: nextWorkshopId(),
    });
    const wa = await makeLocation(ctx.db, {
      type: 'production',
      name: waName,
      posterWorkshopId: nextWorkshopId(),
    });
    const legacy = await makeLocation(ctx.db, { type: 'production' });
    const store = await makeLocation(ctx.db, { type: 'store' });

    const res = await request(ctx.app)
      .get('/api/products/workshops')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const rows = res.body as { id: number; name: string }[];

    // Every returned row is a canonical workshop (no legacy / store).
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(wa);
    expect(ids).toContain(wb);
    expect(ids).not.toContain(legacy);
    expect(ids).not.toContain(store);

    // Shape: exactly {id, name}.
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['id', 'name']);
      expect(typeof r.id).toBe('number');
      expect(typeof r.name).toBe('string');
    }

    // Ordered by name (ascending).
    const names = rows.map((r) => r.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('a store manager can read the workshops list (filter is visible to viewers)', async () => {
    const mgr = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: await makeLocation(ctx.db, { type: 'store' }),
    });
    const res = await request(ctx.app)
      .get('/api/products/workshops')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('recipes / BOM', () => {
  it('PUT replaces the BOM with valid components', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw' });
    const sugar = await makeProduct(ctx.db, { type: 'raw' });

    const res = await request(ctx.app)
      .put(`/api/products/${cake}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        recipe: [
          { component_product_id: flour, qty_per_unit: 0.5 },
          { component_product_id: sugar, qty_per_unit: 0.25 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.recipe).toHaveLength(2);

    // A second PUT fully replaces (not appends).
    const replaced = await request(ctx.app)
      .put(`/api/products/${cake}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: flour, qty_per_unit: 1 }] });
    expect(replaced.status).toBe(200);
    expect(replaced.body.recipe).toHaveLength(1);
  });

  it('GET returns a nested tree with bottom-up cost + product total_cost', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    // finished cake -> prepack(crem) -> raw(milk, cost 20/kg) ; cake -> raw(flour, cost 7.5/kg)
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const crem = await makeProduct(ctx.db, { type: 'semi' });
    const milk = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    // Catalog price = manual_cost_per_unit ALONE (no Poster fallback), so seed
    // the raw leaf costs via the MANUAL field.
    await ctx.db.query(`UPDATE products SET manual_cost_per_unit = 20 WHERE id = $1`, [milk]);
    await ctx.db.query(`UPDATE products SET manual_cost_per_unit = 7.5 WHERE id = $1`, [flour]);

    // crem = 2 kg milk per unit -> unit_cost 40
    await request(ctx.app)
      .put(`/api/products/${crem}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: milk, qty_per_unit: 2 }] });
    // cake = 0.5 crem + 0.3 flour per unit
    await request(ctx.app)
      .put(`/api/products/${cake}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        recipe: [
          { component_product_id: crem, qty_per_unit: 0.5 },
          { component_product_id: flour, qty_per_unit: 0.3 },
        ],
      });

    const res = await request(ctx.app)
      .get(`/api/products/${cake}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    // Backward-friendly flat array still present.
    expect(res.body.recipe).toHaveLength(2);
    // Nested tree.
    const tree = res.body.tree as Array<{
      component_product_id: number;
      type: string;
      unit_cost: number | null;
      line_cost: number | null;
      brutto: number | null;
      netto: number | null;
      children: Array<{ component_product_id: number; unit_cost: number | null }>;
    }>;
    expect(tree).toHaveLength(2);
    const cremNode = tree.find((n) => n.component_product_id === crem);
    expect(cremNode?.type).toBe('semi');
    expect(cremNode?.unit_cost).toBeCloseTo(40, 2); // 2 kg milk * 20
    expect(cremNode?.line_cost).toBeCloseTo(20, 2); // 0.5 crem * 40
    expect(cremNode?.children).toHaveLength(1);
    expect(cremNode?.children[0]?.component_product_id).toBe(milk);
    const flourNode = tree.find((n) => n.component_product_id === flour);
    expect(flourNode?.line_cost).toBeCloseTo(2.25, 2); // 0.3 * 7.5
    // product total = 20 + 2.25 = 22.25
    expect(res.body.total_cost).toBeCloseTo(22.25, 2);
    // Manually-entered lines (PUT) carry no Poster brutto/netto source.
    expect(cremNode?.brutto).toBeNull();
    expect(cremNode?.netto).toBeNull();
    expect(flourNode?.brutto).toBeNull();
    expect(flourNode?.netto).toBeNull();
  });

  it('GET tree surfaces stored Poster brutto/netto on each line', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const prepack = await makeProduct(ctx.db, { type: 'semi', unit: 'kg' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query(`UPDATE products SET manual_cost_per_unit = 7.5 WHERE id = $1`, [flour]);
    // Simulate a Poster-synced line: qty_per_unit derived (per-output-unit),
    // brutto/netto the raw structure figures (grams) stored alongside.
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, netto)
       VALUES ($1, $2, 0.31, 310, 1000)`,
      [prepack, flour],
    );

    const res = await request(ctx.app)
      .get(`/api/products/${prepack}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const node = res.body.tree[0] as {
      component_product_id: number;
      qty_per_unit: number;
      brutto: number | null;
      netto: number | null;
      line_cost: number | null;
    };
    expect(node.component_product_id).toBe(flour);
    expect(node.qty_per_unit).toBeCloseTo(0.31, 4);
    expect(node.brutto).toBeCloseTo(310, 4);
    expect(node.netto).toBeCloseTo(1000, 4);
    expect(node.line_cost).toBeCloseTo(2.33, 2); // 0.31 * 7.5 = 2.325, rounded to 2dp
  });

  it('GET total_cost is null when a leaf cost is unknown (never faked to 0)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const mystery = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' }); // no cost_per_unit
    await request(ctx.app)
      .put(`/api/products/${cake}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: mystery, qty_per_unit: 1 }] });

    const res = await request(ctx.app)
      .get(`/api/products/${cake}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.total_cost).toBeNull();
    expect(res.body.tree[0].line_cost).toBeNull();
  });

  it('AC2.2 — rejects a direct self-reference (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'semi' });

    const res = await request(ctx.app)
      .put(`/api/products/${product}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: product, qty_per_unit: 1 }] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('AC2.2 — rejects a deep cycle A -> B -> A (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const a = await makeProduct(ctx.db, { type: 'semi' });
    const b = await makeProduct(ctx.db, { type: 'semi' });

    // B's BOM contains A.
    const setB = await request(ctx.app)
      .put(`/api/products/${b}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: a, qty_per_unit: 1 }] });
    expect(setB.status).toBe(200);

    // Now A's BOM contains B -> would close the cycle A -> B -> A.
    const setA = await request(ctx.app)
      .put(`/api/products/${a}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: b, qty_per_unit: 1 }] });
    expect(setA.status).toBe(422);
    expect(setA.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a recipe with a non-existent component (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .put(`/api/products/${product}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: 999999, qty_per_unit: 1 }] });
    expect(res.status).toBe(422);
  });

  it('GET recipe returns the stored BOM', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw' });
    await request(ctx.app)
      .put(`/api/products/${cake}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: flour, qty_per_unit: 2 }] });

    const res = await request(ctx.app)
      .get(`/api/products/${cake}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.recipe).toHaveLength(1);
    expect(Number(res.body.recipe[0].component_product_id)).toBe(flour);
  });
});
