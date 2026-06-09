-- =============================================================================
-- 0060 — TZ Module 6: dedicated cream/krem production workshop ("Qaymoq sexi").
-- =============================================================================
-- TZ §6 "Qaymoq krem ishlab chiqarish bo'limi". The chain gains an APP-OWNED
-- production отдел whose only job is to make whipped cream (qaymoq krem) and
-- hand it to the other sexes (Tort, Perojniy, …) that consume it as a
-- `decoration`-stage BOM component. Like the other sexes, it has its OWN
-- `sex_storage` buffer ("Qaymoq skladi") between the floor and its consumers.
--
-- App-owned, NOT Poster-synced: Poster has no "Цех" for cream (the cream is a
-- recipe component, not a saleable dish), so `poster_workshop_id` stays NULL.
-- That is deliberate — it marks this as ADIA-managed config, exactly like the
-- legacy seed sexes created by scripts/seed-dev.ts.
--
-- This migration seeds STRUCTURE only (locations, the per-product producer
-- link, the M:N flows). The dev login account for the Qaymoq managers is
-- created by scripts/seed-dev.ts (it bcrypts the password + syncs
-- user_locations — neither is expressible in SQL), exactly like every other
-- sex manager. On a real deployment the owner staffs the manager via the admin
-- UI (D6 — every location has a manager).
--
-- Topology (mirrors migration 0026 + 0028 direction conventions EXACTLY):
--   * Qaymoq sexi   -> Qaymoq skladi   (production_output)  — floor ships its
--                                                             batch into its buffer
--   * Qaymoq skladi -> Tort sexi       (bom_input)          — buffer feeds the
--   * Qaymoq skladi -> Perojniy sexi   (bom_input)            consuming sexes
--   * Qaymoq skladi -> central wh      (forward)            — same blanket rule
--                                                             0028 applies to
--                                                             every sex_storage
--
-- The `location_type` enum already has 'production' (0001) and 'sex_storage'
-- (0021); the `product_type` enum already has 'semi' (0001). No enum change.
--
-- IDEMPOTENT: every INSERT is gated by NOT EXISTS / ON CONFLICT DO NOTHING and
-- every UPDATE by IS DISTINCT FROM, so a re-run is a no-op. When the production
-- root does not yet exist (a fresh DB before seed-dev, or a bare test schema)
-- the whole block is skipped with a NOTICE — exactly like migrations 0016/0019.
-- =============================================================================

DO $$
DECLARE
  v_root          BIGINT;   -- the production root ("Ishlab chiqarish sexi")
  v_qaymoq_sexi   BIGINT;   -- the cream production отдел
  v_qaymoq_skladi BIGINT;   -- its sex_storage buffer
  v_tort_sexi     BIGINT;
  v_perojniy_sexi BIGINT;
  v_central       BIGINT;
  v_cream_product BIGINT;   -- the resolved/created cream semi product
BEGIN
  -- ---------------------------------------------------------------------------
  -- 1. Resolve the production root. Prefer the canonical seed name; otherwise
  --    the lowest-id parentless production row; otherwise the lowest-id
  --    production row (same fallback ladder migration 0016 uses).
  -- ---------------------------------------------------------------------------
  SELECT id INTO v_root
    FROM locations
   WHERE type = 'production' AND name = 'Ishlab chiqarish sexi'
   ORDER BY id
   LIMIT 1;

  IF v_root IS NULL THEN
    SELECT id INTO v_root
      FROM locations
     WHERE type = 'production' AND parent_id IS NULL
     ORDER BY id
     LIMIT 1;
  END IF;

  IF v_root IS NULL THEN
    SELECT id INTO v_root
      FROM locations
     WHERE type = 'production'
     ORDER BY id
     LIMIT 1;
  END IF;

  IF v_root IS NULL THEN
    RAISE NOTICE '0060 cream-workshop seed: no production root found, skipping.';
    RETURN;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 2. "Qaymoq sexi" (type=production, app-owned -> poster_workshop_id NULL).
  --    Guarded by NOT EXISTS on the (name, type) tuple — re-run is a no-op.
  -- ---------------------------------------------------------------------------
  SELECT id INTO v_qaymoq_sexi
    FROM locations
   WHERE name = 'Qaymoq sexi' AND type = 'production'
   LIMIT 1;

  IF v_qaymoq_sexi IS NULL THEN
    INSERT INTO locations (name, type, parent_id, is_active)
    VALUES ('Qaymoq sexi', 'production'::location_type, v_root, TRUE)
    RETURNING id INTO v_qaymoq_sexi;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 3. "Qaymoq skladi" (type=sex_storage, parent = Qaymoq sexi). Mirrors every
  --    other sex skladi (migration 0022: a sex_storage's parent is its floor).
  -- ---------------------------------------------------------------------------
  SELECT id INTO v_qaymoq_skladi
    FROM locations
   WHERE name = 'Qaymoq skladi' AND type = 'sex_storage'
   LIMIT 1;

  IF v_qaymoq_skladi IS NULL THEN
    INSERT INTO locations (name, type, parent_id, is_active)
    VALUES ('Qaymoq skladi', 'sex_storage'::location_type, v_qaymoq_sexi, TRUE)
    RETURNING id INTO v_qaymoq_skladi;
  ELSE
    -- Keep the parent correct if the row pre-exists from a partial run.
    UPDATE locations
       SET parent_id = v_qaymoq_sexi, updated_at = now()
     WHERE id = v_qaymoq_skladi
       AND parent_id IS DISTINCT FROM v_qaymoq_sexi;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 4. The cream product. Search the existing catalogue for a whipped-cream
  --    SEMI (qaymoq / krem / крем / сливк, case-insensitive). If one already
  --    exists (Poster-synced prepack), adopt it; otherwise create ONE app-owned
  --    semi "Qaymoq krem" (kg, empty recipe — the production dialog + manager
  --    fill the BOM later). Either way its producer is set to Qaymoq sexi.
  --
  --    The search is INTENTIONALLY narrow (anchored words) so it does not grab
  --    a finished cake whose NAME merely contains "krem". We restrict to
  --    type='semi' for the same reason.
  -- ---------------------------------------------------------------------------
  SELECT id INTO v_cream_product
    FROM products
   WHERE type = 'semi'
     AND (
       name ILIKE '%qaymoq%' OR
       name ILIKE '%krem%'   OR
       name ILIKE '%крем%'   OR
       name ILIKE '%сливк%'
     )
   ORDER BY
     -- Prefer an explicit "qaymoq krem" match, then shortest name (the base
     -- ingredient over a composite filling), then lowest id — deterministic.
     (name ILIKE '%qaymoq%') DESC,
     length(name),
     id
   LIMIT 1;

  IF v_cream_product IS NULL THEN
    INSERT INTO products (name, type, unit, sku)
    VALUES ('Qaymoq krem', 'semi'::product_type, 'kg'::unit_type, 'SEMI-QAYMOQ-KREM')
    RETURNING id INTO v_cream_product;
    RAISE NOTICE '0060 cream-workshop seed: created cream product id=% (Qaymoq krem).', v_cream_product;
  ELSE
    RAISE NOTICE '0060 cream-workshop seed: adopted existing cream product id=%.', v_cream_product;
  END IF;

  -- Point the cream product at its producing отдел (idempotent).
  UPDATE products
     SET workshop_location_id = v_qaymoq_sexi, updated_at = now()
   WHERE id = v_cream_product
     AND workshop_location_id IS DISTINCT FROM v_qaymoq_sexi;

  -- ---------------------------------------------------------------------------
  -- 5. Flows. Resolve the cream-consuming sexes + central warehouse, then wire
  --    the edges with the SAME flow_type direction convention as 0026/0028.
  -- ---------------------------------------------------------------------------
  SELECT id INTO v_tort_sexi
    FROM locations WHERE name = 'Tort sexi' AND type = 'production' LIMIT 1;
  SELECT id INTO v_perojniy_sexi
    FROM locations WHERE name = 'Perojniy sexi' AND type = 'production' LIMIT 1;
  SELECT id INTO v_central
    FROM locations
   WHERE type = 'central_warehouse'
     AND (name = 'Markaziy Sklad' OR name ILIKE '%центральный%' OR name ILIKE '%markaziy%'
          OR poster_storage_id = 8)
   ORDER BY (poster_storage_id IS NOT NULL) DESC, id
   LIMIT 1;

  -- 5a. Qaymoq sexi -> Qaymoq skladi (production_output).
  INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
  VALUES (v_qaymoq_sexi, v_qaymoq_skladi, 'production_output')
  ON CONFLICT DO NOTHING;

  -- 5b. Qaymoq skladi -> consuming sexes (bom_input) — buffer feeds the sex
  --     that puts cream into its recipe (same direction as Yarim Fabrika
  --     skladi -> Tort/Perojniy in 0026).
  IF v_tort_sexi IS NOT NULL THEN
    INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
    VALUES (v_qaymoq_skladi, v_tort_sexi, 'bom_input')
    ON CONFLICT DO NOTHING;
  END IF;
  IF v_perojniy_sexi IS NOT NULL THEN
    INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
    VALUES (v_qaymoq_skladi, v_perojniy_sexi, 'bom_input')
    ON CONFLICT DO NOTHING;
  END IF;

  -- 5c. Qaymoq skladi -> central warehouse (forward) — the blanket rule 0028
  --     applies to EVERY sex_storage.
  IF v_central IS NOT NULL THEN
    INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
    VALUES (v_qaymoq_skladi, v_central, 'forward')
    ON CONFLICT DO NOTHING;
  END IF;

  RAISE NOTICE '0060 cream-workshop seed: Qaymoq sexi=% skladi=% cream_product=% root=%.',
    v_qaymoq_sexi, v_qaymoq_skladi, v_cream_product, v_root;
END$$;
