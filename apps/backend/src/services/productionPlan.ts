/**
 * cross-department-flow-plan §6.4 — the N-component recursive "Manba reja"
 * (source plan) resolver. This GENERALISES the two-question production dialog
 * (`productionDialog.ts`, ADR-0016): instead of one zagatovka + one cream
 * question, the sex boss is shown ONE screen with the state + a per-line
 * decision for EVERY decoration-BOM component.
 *
 * Two entry points:
 *   - `analyzeProductionPlan` (READ-ONLY) — classify each decoration line
 *     (raw vs the three semi kinds), read availability at the RIGHT place (the
 *     v2 fix: a foreign semi's stock is read at the PRODUCER's sex_storage, not
 *     the requester's), suggest a per-line action, and surface any already-open
 *     request for the (component, producer-target). No DB writes.
 *   - `executeProductionPlan` (ONE withTransaction, all-or-nothing) — apply the
 *     boss's per-line decisions: transfer-as-reserve for ready stock (§7-A),
 *     a zagatovka sub-order for "make from zero", a producer sub-request (linked
 *     into the request tree, §8) for "order", a purchase request for a short
 *     raw ("ombordan"). Any one failure rolls EVERYTHING back (§13).
 *
 * Reuse, not reinvention (the plan's first principle):
 *   - decoration BOM            → `readFinalBom` (bom.ts, already decoration-only);
 *   - the producer-storage rule → mirrors `crossDeptRequest`'s LATERAL lookup;
 *   - "make from zero"          → `insertZagatovkaOrder` (productionDialog.ts);
 *   - "order" from a producer   → `createCrossDeptRequestInTx` (the tx-scoped
 *                                  variant) + `linkWaiter` / `topUpQtyIfPreAccept`
 *                                  on the invariant-2 shared-child path (§8);
 *   - "ombordan" (short raw)    → `raiseSupplyRequest` (productionDialog.ts) —
 *                                  the SAME OQ5 purchase the dialog emits.
 *
 * Invariants honoured here:
 *   - 1 (atomicity)  — every emitted document + audit + reserve-transfer in the
 *                      `execute` path runs inside ONE `withTransaction`.
 *   - 2 (one open)   — a producer sub-request never duplicates an open child;
 *                      it links a waiter instead (`createCrossDeptRequestInTx`).
 *   - 3 (no negative)— reserve transfers go through `applyMovement` (guarded).
 *   - 5 (audit)      — every create writes an audit row (via the shared helpers
 *                      and `writeAudit` here).
 */
import { withTransaction, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { writeAudit } from '../lib/audit.js';
import { readFinalBom } from './bom.js';
import { applyMovement } from './stockMovement.js';
import {
  createCrossDeptRequestInTx,
  type CrossDeptTarget,
} from './crossDeptRequest.js';
import {
  insertZagatovkaOrder,
  raiseSupplyRequest,
} from './productionDialog.js';
import {
  linkWaiter,
  topUpQtyIfPreAccept,
} from './replenishment.js';
import { createNotification, getLocationManager } from './notify.js';

// -----------------------------------------------------------------------------
// A queryable client — the pool runner or an open transaction (mirrors bom.ts).
// -----------------------------------------------------------------------------
type Runner = Pick<TxClient, 'query'>;

// -----------------------------------------------------------------------------
// Types — the analyze return shape is PINNED (the frontend consumes it as-is).
// -----------------------------------------------------------------------------

/**
 * How a decoration component is sourced, per §6.4:
 *   - `raw`           — a raw material (homashyo / bezak); transfer or purchase.
 *   - `semi_own`      — a semi whose producer IS this sex (make it here / use ready).
 *   - `semi_inplace`  — a semi with NO producer link (workshop_location_id NULL);
 *                       made in place at this sex (a local zagatovka).
 *   - `semi_producer` — a semi made by ANOTHER sex (e.g. cream → Qaymoq); ordered.
 */
export type PlanLineKind = 'raw' | 'semi_own' | 'semi_inplace' | 'semi_producer';

/** The per-line suggested action (the default radio the boss sees). */
export type PlanLineAction = 'use_ready' | 'make' | 'order' | 'transfer' | 'purchase';

/** The producing sex of a semi component (null for raw / no producer). */
export type PlanProducer = {
  readonly location_id: number;
  readonly name: string;
  /** The producer's sex_storage buffer (lowest-id active child); null if none. */
  readonly storage_location_id: number | null;
};

export type PlanLine = {
  readonly component_product_id: number;
  readonly name: string;
  readonly type: 'raw' | 'semi';
  readonly unit: string;
  /** How much of this component ONE plan needs (qty_per_unit × plan qty). */
  readonly need: number;
  readonly kind: PlanLineKind;
  /** The producing sex (semi only; null for raw or a no-producer in-place semi). */
  readonly producer: PlanProducer | null;
  readonly available: {
    /** On-hand at the SOURCE this line would draw from (producer storage / own sex). */
    readonly at_source: number;
    /** On-hand at the raw warehouse (raw lines only; null for semis). */
    readonly at_raw: number | null;
  };
  /** min(have, need) — how much can be covered from `at_source` right now. */
  readonly qty_ready: number;
  readonly suggested: PlanLineAction;
  /** An already-open request for (component, producer-target), if any (§8). */
  readonly open_request_id: number | null;
};

export type ProductionPlan = {
  readonly product_id: number;
  readonly qty: number;
  readonly location_id: number;
  readonly lines: PlanLine[];
};

// -----------------------------------------------------------------------------
// Topology helpers (local — keep the service self-contained, mirror the dialog)
// -----------------------------------------------------------------------------

/**
 * Resolve the raw warehouse + (own) sex_storage around a PRODUCTION sex floor.
 * `sexLocationId` is the sex floor the plan is being made AT. The raw warehouse
 * is the first `raw_warehouse` ancestor; the own sex_storage is the floor's
 * lowest-id active `sex_storage` child (mirrors `resolveTopology` in
 * replenishment.ts — the chain walk goes UP, the sex_storage is a CHILD).
 */
async function resolveSexTopology(
  runner: Runner,
  sexLocationId: number,
): Promise<{ rawWarehouseId: number | null; ownSexStorageId: number | null }> {
  const { rows } = await runner.query<{ id: string; type: string }>(
    `WITH RECURSIVE chain AS (
       SELECT id, type, parent_id, 0 AS depth FROM locations WHERE id = $1
       UNION ALL
       SELECT l.id, l.type, l.parent_id, c.depth + 1
       FROM locations l JOIN chain c ON l.id = c.parent_id
     )
     SELECT id, type FROM chain ORDER BY depth`,
    [sexLocationId],
  );
  let rawWarehouseId: number | null = null;
  for (const r of rows) {
    if (rawWarehouseId === null && r.type === 'raw_warehouse') rawWarehouseId = Number(r.id);
  }
  const { rows: sexRows } = await runner.query<{ id: string }>(
    `SELECT id FROM locations
      WHERE parent_id = $1 AND type = 'sex_storage'::location_type AND is_active = TRUE
      ORDER BY id LIMIT 1`,
    [sexLocationId],
  );
  const ownSexStorageId = sexRows[0] !== undefined ? Number(sexRows[0].id) : null;
  return { rawWarehouseId, ownSexStorageId };
}

/**
 * The producing sex of a `semi` component + that sex's sex_storage buffer.
 * Mirrors `crossDeptRequest.resolveRequestTarget`'s LATERAL: producer =
 * `products.workshop_location_id` (the Poster Цех, or app-owned Qaymoq);
 * its storage = the workshop's lowest-id active `sex_storage` child. Returns
 * null when the component has no `workshop_location_id` (an in-place semi).
 */
async function resolveProducer(
  runner: Runner,
  componentProductId: number,
): Promise<PlanProducer | null> {
  const { rows } = await runner.query<{
    workshop_id: string;
    workshop_name: string;
    storage_id: string | null;
  }>(
    `SELECT workshop.id   AS workshop_id,
            workshop.name AS workshop_name,
            store.id      AS storage_id
       FROM products p
       JOIN locations workshop ON workshop.id = p.workshop_location_id
                              AND workshop.is_active = TRUE
       LEFT JOIN LATERAL (
         SELECT s.id
           FROM locations s
          WHERE s.parent_id = workshop.id
            AND s.type = 'sex_storage'::location_type
            AND s.is_active = TRUE
          ORDER BY s.id
          LIMIT 1
       ) store ON TRUE
      WHERE p.id = $1
        AND p.type = 'semi'::product_type
        AND p.workshop_location_id IS NOT NULL`,
    [componentProductId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    location_id: Number(row.workshop_id),
    name: row.workshop_name,
    storage_location_id: row.storage_id === null ? null : Number(row.storage_id),
  };
}

async function readStockQty(
  runner: Runner,
  locationId: number | null,
  productId: number,
): Promise<number> {
  if (locationId === null) return 0;
  const { rows } = await runner.query<{ qty: string }>(
    'SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2',
    [locationId, productId],
  );
  const raw = rows[0]?.qty;
  return raw === undefined ? 0 : Number(raw);
}

/** Product metadata a line needs (name/type/unit). */
async function readProductMeta(
  runner: Runner,
  productId: number,
): Promise<{ name: string; type: 'raw' | 'semi' | 'finished'; unit: string }> {
  const { rows } = await runner.query<{ name: string; type: 'raw' | 'semi' | 'finished'; unit: string }>(
    `SELECT name, type::text AS type, unit FROM products WHERE id = $1`,
    [productId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw AppError.notFound(`Product ${productId} not found.`);
  }
  return { name: row.name, type: row.type, unit: row.unit };
}

/**
 * An already-open request for (component, producer-target), surfaced so the UI
 * can show "shu producer'ga ochiq so'rov bor" and the boss does not double-order
 * (§8). Mirrors the debounce predicate: open + same product + pinned to the
 * producer storage (or requested at the requester sex for the in-place case).
 */
async function findOpenRequest(
  runner: Runner,
  productId: number,
  requesterLocationId: number,
  producerStorageId: number | null,
): Promise<number | null> {
  const { rows } = await runner.query<{ id: string }>(
    `SELECT id FROM replenishment_requests
      WHERE product_id = $1
        AND status NOT IN ('CLOSED', 'CANCELLED')
        AND (
          requester_location_id = $2
          OR ($3::bigint IS NOT NULL AND target_location_id = $3)
        )
      ORDER BY id
      LIMIT 1`,
    [productId, requesterLocationId, producerStorageId],
  );
  return rows[0] !== undefined ? Number(rows[0].id) : null;
}

// -----------------------------------------------------------------------------
// analyze — read-only N-line source plan
// -----------------------------------------------------------------------------

export async function analyzeProductionPlan(
  runner: Runner,
  opts: { productId: number; qty: number; sexLocationId: number },
): Promise<ProductionPlan> {
  if (!Number.isFinite(opts.qty) || opts.qty <= 0) {
    throw AppError.validation('qty must be a number greater than zero.');
  }

  const { rawWarehouseId, ownSexStorageId } = await resolveSexTopology(runner, opts.sexLocationId);
  const bom = await readFinalBom(runner, opts.productId);

  const lines: PlanLine[] = [];
  for (const bomLine of bom) {
    const componentId = bomLine.component_product_id;
    const need = bomLine.qty_per_unit * opts.qty;
    const meta = await readProductMeta(runner, componentId);

    if (meta.type === 'semi') {
      // --- SEMI: producer = workshop_location_id; availability at PRODUCER -----
      const producer = await resolveProducer(runner, componentId);
      // Classify the three semi kinds (§6.4).
      let kind: PlanLineKind;
      if (producer === null) {
        kind = 'semi_inplace'; // no producer link → made in place here.
      } else if (producer.location_id === opts.sexLocationId) {
        kind = 'semi_own'; // this very sex makes it.
      } else {
        kind = 'semi_producer'; // a foreign sex (e.g. cream → Qaymoq).
      }

      // v2 FIX — availability is read at the PRODUCER's sex_storage, NOT this
      // sex's own storage (a foreign semi sits in Qaymoq's sklad). For an
      // in-place semi (no producer) the source is THIS sex's own storage.
      const sourceStorageId =
        producer !== null ? producer.storage_location_id : ownSexStorageId;
      const atSource = await readStockQty(runner, sourceStorageId, componentId);
      const qtyReady = Math.min(atSource, need);

      // Suggested action: ready stock covers it → use_ready; else make (own /
      // in-place — we can produce it here) or order (a foreign producer).
      let suggested: PlanLineAction;
      if (atSource >= need) {
        suggested = 'use_ready';
      } else if (kind === 'semi_producer') {
        suggested = 'order';
      } else {
        suggested = 'make';
      }

      const openRequestId = await findOpenRequest(
        runner,
        componentId,
        opts.sexLocationId,
        producer?.storage_location_id ?? null,
      );

      lines.push({
        component_product_id: componentId,
        name: meta.name,
        type: 'semi',
        unit: meta.unit,
        need,
        kind,
        producer,
        available: { at_source: atSource, at_raw: null },
        qty_ready: qtyReady,
        suggested,
        open_request_id: openRequestId,
      });
    } else {
      // --- RAW: source = own sex_storage first, then the raw warehouse --------
      // (`at_source` is the own-sex buffer; `at_raw` is the raw warehouse.) The
      // suggested transfer pulls from the raw warehouse (the canonical homashyo
      // source); `qty_ready` is what the raw warehouse can cover now.
      const atSource = await readStockQty(runner, ownSexStorageId, componentId);
      const atRaw = await readStockQty(runner, rawWarehouseId, componentId);
      const qtyReady = Math.min(atRaw, need);
      const suggested: PlanLineAction = atRaw >= need ? 'transfer' : 'purchase';

      lines.push({
        component_product_id: componentId,
        name: meta.name,
        type: 'raw',
        unit: meta.unit,
        need,
        kind: 'raw',
        producer: null,
        available: { at_source: atSource, at_raw: atRaw },
        qty_ready: qtyReady,
        suggested,
        open_request_id: null,
      });
    }
  }

  return { product_id: opts.productId, qty: opts.qty, location_id: opts.sexLocationId, lines };
}

// -----------------------------------------------------------------------------
// execute — apply the per-line decisions in ONE transaction (all-or-nothing)
// -----------------------------------------------------------------------------

/** One decision the boss made on a line (the radio choice + optional split). */
export type PlanDecision = {
  readonly component_product_id: number;
  readonly action: PlanLineAction;
  /**
   * Use-partial: how much to draw from ready stock (`use_ready` / `transfer`).
   * When < need, only this much is reserved; the remainder is the caller's
   * responsibility (another decision line, or a follow-up). Defaults to the
   * line's full `need` / `qty_ready` when omitted.
   */
  readonly qty_ready?: number;
};

/** What one executed decision emitted (for the response + the caller's UI). */
export type ExecutedLine = {
  readonly component_product_id: number;
  readonly action: PlanLineAction;
  readonly movement_id?: number;
  readonly production_order_id?: number;
  readonly request_id?: number;
  readonly purchase_order_id?: number;
  /** §8 — a producer sub-request linked a waiter onto an existing open child. */
  readonly waiter_linked?: boolean;
  /** §8 — that existing child's qty was topped up (only while still NEW, #9). */
  readonly qty_topped_up?: boolean;
};

export type ExecuteResult = {
  readonly executed: ExecutedLine[];
};

/**
 * A producer sub-request that needs its target manager pinged AFTER commit.
 * The notification is best-effort and must NOT roll the (already-valid) plan
 * back, so it lives OUTSIDE the transaction — exactly how the engine / cron
 * fan their notifications out post-commit. Collected during the tx, sent after.
 */
type PendingNotify = {
  readonly requestId: number;
  readonly componentProductId: number;
  readonly qty: number;
  readonly target: CrossDeptTarget;
};

/**
 * Apply the source-plan decisions. ONE `withTransaction` — a failure on ANY
 * line (e.g. an INSUFFICIENT_STOCK from a reserve transfer) rolls back EVERY
 * document already emitted for this plan (§13 "ishlab chiqarishda komponent
 * yetmay qoldi → BUTUN tranzaksiya rollback").
 *
 * The root request (`requestId`, when given) is NOT force-advanced here — per
 * §7-A it stays WAITING while its children fill; F-D chains it forward once the
 * children close. We only attach the emitted documents (reserve transfers carry
 * `replenishmentId=requestId`; the producer sub-request links into the tree).
 */
export async function executeProductionPlan(opts: {
  requestId?: number | null;
  productId: number;
  qty: number;
  sexLocationId: number;
  decisions: PlanDecision[];
  actorUserId: number | null;
}): Promise<ExecuteResult> {
  if (!Number.isFinite(opts.qty) || opts.qty <= 0) {
    throw AppError.validation('qty must be a number greater than zero.');
  }
  if (!Array.isArray(opts.decisions) || opts.decisions.length === 0) {
    throw AppError.validation('decisions must be a non-empty array.');
  }
  const requestId = opts.requestId ?? null;

  // Collected INSIDE the tx, sent AFTER commit (best-effort) — see PendingNotify.
  const notifyQueue: PendingNotify[] = [];

  const result = await withTransaction(async (tx) => {
    // The root request (when given) gives us the tree placement for any
    // producer sub-request: parent = the root, depth = root.depth + 1, root =
    // the root's own root (NULL → self, derived by createRequestInTx). We read
    // it ONCE up front (FOR UPDATE so the plan + the root stay consistent).
    let rootDepth = 0;
    let rootOfRoot: number | null = null;
    if (requestId !== null) {
      const { rows } = await tx.query<{ depth: number; root_request_id: number | null }>(
        `SELECT depth, root_request_id FROM replenishment_requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      const root = rows[0];
      if (root === undefined) {
        throw AppError.notFound(`Replenishment request ${requestId} not found.`);
      }
      rootDepth = Number(root.depth);
      rootOfRoot = root.root_request_id === null ? requestId : Number(root.root_request_id);
    }

    // Resolve the topology once (own sex_storage / raw warehouse) — every line
    // shares it. The decoration BOM gives the per-line `need` (qty_per_unit × qty).
    const { rawWarehouseId, ownSexStorageId } = await resolveSexTopology(tx, opts.sexLocationId);
    const bom = await readFinalBom(tx, opts.productId);
    const needByComponent = new Map<number, number>();
    for (const line of bom) {
      needByComponent.set(line.component_product_id, line.qty_per_unit * opts.qty);
    }

    const executed: ExecutedLine[] = [];
    for (const decision of opts.decisions) {
      const componentId = decision.component_product_id;
      const need = needByComponent.get(componentId);
      if (need === undefined) {
        throw AppError.validation(
          `Component ${componentId} is not in the decoration BOM of product ${opts.productId}.`,
        );
      }
      executed.push(
        await executeLine(tx, {
          decision,
          need,
          requestId,
          rootDepth,
          rootOfRoot,
          sexLocationId: opts.sexLocationId,
          ownSexStorageId,
          rawWarehouseId,
          actorUserId: opts.actorUserId,
          notifyQueue,
        }),
      );
    }

    // Audit the whole plan execution (one summary row alongside the per-document
    // audits the shared helpers already wrote — invariant 5).
    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'production_plan.execute',
      entity: 'replenishment_requests',
      entityId: requestId ?? opts.productId,
      payload: {
        product_id: opts.productId,
        qty: opts.qty,
        sex_location_id: opts.sexLocationId,
        request_id: requestId,
        executed: executed.map((e) => ({ component_product_id: e.component_product_id, action: e.action })),
      },
    });

    return { executed };
  });

  // Post-commit, best-effort: ping each foreign producer's manager about the new
  // sub-request (the §11 "So'rov yaratildi → target manager" row), with the same
  // inline ✅/❌ xreq buttons `createCrossDeptRequest` uses. A failure here must
  // NOT undo the committed plan — mirror the engine: log and move on.
  for (const pending of notifyQueue) {
    await notifyProducerManager(pending).catch((err: unknown) => {
      console.error(
        '[production-plan] producer notify failed:',
        (err as Error).message,
      );
    });
  }

  return result;
}

/** Post-commit notify of a producer sub-request's target manager (best-effort). */
async function notifyProducerManager(pending: PendingNotify): Promise<void> {
  await withTransaction(async (tx) => {
    const managerId = await getLocationManager(tx, pending.target.locationId);
    if (managerId === null) return;
    const meta = await readProductMeta(tx, pending.componentProductId);
    await createNotification(tx, {
      recipientUserId: managerId,
      type: 'replenishment_created',
      title: `Yangi so'rov — ${pending.target.name}`,
      body:
        `${meta.name} × ${pending.qty} ${meta.unit}\n` +
        `So'rov #${pending.requestId} ishlab chiqarish rejasidan keldi.`,
      payload: {
        replenishment_id: pending.requestId,
        target_location_id: pending.target.locationId,
        product_id: pending.componentProductId,
        qty: pending.qty,
      },
      inlineCallback: {
        buttons: [
          [
            { text: '✅ Qabul', data: `xreq:accept:${pending.requestId}` },
            { text: '❌ Rad', data: `xreq:reject:${pending.requestId}` },
          ],
        ],
      },
    });
  });
}

/** Apply ONE decision line inside the plan's transaction. */
async function executeLine(
  tx: TxClient,
  ctx: {
    decision: PlanDecision;
    need: number;
    requestId: number | null;
    rootDepth: number;
    rootOfRoot: number | null;
    sexLocationId: number;
    ownSexStorageId: number | null;
    rawWarehouseId: number | null;
    actorUserId: number | null;
    notifyQueue: PendingNotify[];
  },
): Promise<ExecutedLine> {
  const { decision, need } = ctx;
  const componentId = decision.component_product_id;

  switch (decision.action) {
    case 'use_ready': {
      // §7-A transfer-as-reserve: move ready semi stock from the PRODUCER's
      // sex_storage INTO this sex floor (note='reserve'), bounded by what is
      // actually on hand so a stale `qty_ready` can never oversell.
      const producer = await resolveProducer(tx, componentId);
      const sourceStorageId =
        producer !== null ? producer.storage_location_id : ctx.ownSexStorageId;
      if (sourceStorageId === null) {
        throw AppError.validation(
          `Cannot use ready stock for component ${componentId} — no source storage resolved.`,
        );
      }
      const have = await readStockQty(tx, sourceStorageId, componentId);
      const want = decision.qty_ready ?? need;
      const qty = Math.min(want, have);
      if (qty <= 0) {
        throw new AppError(
          'INSUFFICIENT_STOCK',
          `No ready stock to reserve for component ${componentId} at location ${sourceStorageId}.`,
        );
      }
      const { movementId } = await applyMovement(
        {
          productId: componentId,
          fromLocationId: sourceStorageId,
          toLocationId: ctx.sexLocationId,
          qty,
          reason: 'transfer',
          actorUserId: ctx.actorUserId,
          replenishmentId: ctx.requestId,
          note: 'reserve',
        },
        tx,
      );
      return { component_product_id: componentId, action: 'use_ready', movement_id: movementId };
    }

    case 'transfer': {
      // RAW reserve: move from the raw warehouse INTO this sex floor (reserve).
      if (ctx.rawWarehouseId === null) {
        throw AppError.validation(
          `Cannot transfer raw component ${componentId} — no raw warehouse resolved.`,
        );
      }
      const have = await readStockQty(tx, ctx.rawWarehouseId, componentId);
      const want = decision.qty_ready ?? need;
      const qty = Math.min(want, have);
      if (qty <= 0) {
        throw new AppError(
          'INSUFFICIENT_STOCK',
          `No raw stock to reserve for component ${componentId} at the raw warehouse.`,
        );
      }
      const { movementId } = await applyMovement(
        {
          productId: componentId,
          fromLocationId: ctx.rawWarehouseId,
          toLocationId: ctx.sexLocationId,
          qty,
          reason: 'transfer',
          actorUserId: ctx.actorUserId,
          replenishmentId: ctx.requestId,
          note: 'reserve',
        },
        tx,
      );
      return { component_product_id: componentId, action: 'transfer', movement_id: movementId };
    }

    case 'make': {
      // semi_own / semi_inplace produced from zero — a zagatovka sub-order at
      // THIS sex floor, output INTO this sex's own sex_storage. Same creation
      // semantics as the dialog (`insertZagatovkaOrder`): stage_role='zagatovka',
      // parent_production_order_id carried (NULL here — the plan's root is a
      // request, not a production order; F-D wires the production order).
      if (ctx.ownSexStorageId === null) {
        throw AppError.validation(
          `Cannot make component ${componentId} — this sex has no sex_storage.`,
        );
      }
      const qty = decision.qty_ready ?? need;
      const productionOrderId = await insertZagatovkaOrder(tx, {
        productId: componentId,
        qty,
        productionLocationId: ctx.sexLocationId,
        sexStorageId: ctx.ownSexStorageId,
        parentProductionOrderId: null,
        replenishmentId: ctx.requestId,
        actorUserId: ctx.actorUserId,
      });
      return {
        component_product_id: componentId,
        action: 'make',
        production_order_id: productionOrderId,
      };
    }

    case 'order': {
      // semi_producer — a sub-request to the foreign producer sex (e.g. cream →
      // Qaymoq), LINKED into the request tree (§8). The tx-scoped variant keeps
      // this inside the plan's all-or-nothing transaction. On invariant-2
      // collision (another root already ordered the same semi from the same
      // producer) we DO NOT fail — we link a waiter onto the existing child and
      // (only while it is still NEW, #9) top its qty up by our shortfall.
      const shortQty = decision.qty_ready ?? need; // how much THIS plan still needs
      const result = await createCrossDeptRequestInTx(tx, {
        productId: componentId,
        requesterLocationId: ctx.sexLocationId,
        qty: shortQty,
        actorUserId: ctx.actorUserId,
        parentRequestId: ctx.requestId,
        rootRequestId: ctx.rootOfRoot,
        depth: ctx.rootDepth + 1,
        origin: 'dialog',
      });
      if (result.kind === 'created') {
        // Queue the producer-manager nudge for AFTER commit (best-effort, §11).
        ctx.notifyQueue.push({
          requestId: result.request.id,
          componentProductId: componentId,
          qty: shortQty,
          target: result.target,
        });
        return {
          component_product_id: componentId,
          action: 'order',
          request_id: result.request.id,
        };
      }
      // kind === 'exists' — invariant-2 coexistence (§8). Link our root as a
      // waiter on the existing child; top up its qty only while pre-accept (#9).
      let waiterLinked = false;
      if (ctx.requestId !== null) {
        waiterLinked = await linkWaiter(tx, result.existingRequestId, ctx.requestId);
      }
      const toppedUp = await topUpQtyIfPreAccept(
        tx,
        result.existingRequestId,
        shortQty,
        ctx.actorUserId,
      );
      return {
        component_product_id: componentId,
        action: 'order',
        request_id: result.existingRequestId,
        waiter_linked: waiterLinked,
        qty_topped_up: toppedUp,
      };
    }

    case 'purchase': {
      // A short raw — "ombordan": the SAME purchase request the dialog's OQ5
      // emits (`raiseSupplyRequest`), requested at the raw warehouse so it flows
      // through the standard two-step supply path. Debounced (returns null on an
      // existing open request — invariant 2).
      const requesterLocationId = ctx.rawWarehouseId ?? ctx.sexLocationId;
      const qty = decision.qty_ready ?? need;
      const doc = await raiseSupplyRequest(tx, {
        productId: componentId,
        requesterLocationId,
        qty,
        actorUserId: ctx.actorUserId,
      });
      // `raiseSupplyRequest` returns a `{ type:'purchase', id, … }` document or
      // null on debounce. The id is a replenishment_request id (the "ombordan"
      // request); surface it as request_id for the caller.
      return doc !== null
        ? { component_product_id: componentId, action: 'purchase', request_id: doc.id }
        : { component_product_id: componentId, action: 'purchase' };
    }

    default: {
      // Exhaustiveness: every PlanLineAction is handled above.
      const never: never = decision.action;
      throw AppError.validation(`Unknown plan action: ${String(never)}.`);
    }
  }
}
