/**
 * M5 — Production order service (spec section 2.5, invariant 5).
 *
 * The "tayyor" (done) flow turns one production order into stock changes,
 * all inside ONE atomic transaction (`withTransaction`):
 *   - for every BOM line: consume `qty_per_unit * order.qty` of the component
 *     out of the production location (`production_input` movement);
 *   - produce `order.qty` of the output product into the target location
 *     (`production_output` movement) — typically the central warehouse;
 *   - flip the order to `done` and stamp `done_at`.
 * If ANY component is short, the whole transaction rolls back — nothing
 * changes (AC5.2). `applyMovement` is reused so each movement keeps its own
 * guarded decrement, ledger row and audit row (invariant 1).
 *
 * The status path is `new -> in_progress -> done` (plus `cancelled`); only a
 * forward step is allowed (`finishProductionOrder` handles `-> done`).
 */
import { withTransaction, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { writeAudit } from '../lib/audit.js';
import { applyMovement } from './stockMovement.js';

export type ProductionOrderRow = {
  id: number;
  product_id: number;
  qty: number;
  location_id: number;
  target_location_id: number | null;
  deadline: string | null;
  status: string;
  replenishment_id: number | null;
  note: string | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  done_at: Date | null;
};

export const PRODUCTION_ORDER_COLUMNS = `id, product_id, qty, location_id,
  target_location_id, deadline, status, replenishment_id, note, created_by,
  created_at, updated_at, done_at`;

/**
 * Run the atomic "done" flow for a production order WITHIN an existing
 * transaction. The caller (route handler or state machine) owns the
 * transaction so the order flip and the replenishment advance can commit
 * together. Throws `INSUFFICIENT_STOCK` (409) when a BOM component is short
 * — the surrounding transaction then rolls back (AC5.1, AC5.2, invariant 5).
 *
 * @returns the movement ids produced (consumption lines + the output line).
 */
export async function consumeBomAndProduce(
  tx: TxClient,
  order: ProductionOrderRow,
  actorUserId: number | null,
): Promise<{ inputMovementIds: number[]; outputMovementId: number }> {
  const orderQty = Number(order.qty);

  // The output must land somewhere — falling back to the production location
  // is NOT allowed; the schema lets target be null, so guard it explicitly.
  if (order.target_location_id === null) {
    throw AppError.validation('Production order has no target_location_id for its output.');
  }

  // BOM lines for the produced product.
  const { rows: bom } = await tx.query<{
    component_product_id: number;
    qty_per_unit: number;
  }>(
    'SELECT component_product_id, qty_per_unit FROM recipes WHERE product_id = $1',
    [order.product_id],
  );
  if (bom.length === 0) {
    throw AppError.validation(
      `Product ${order.product_id} has no recipe (BOM); cannot run the production flow.`,
    );
  }

  // Consume every component out of the production location. `applyMovement`'s
  // guarded decrement raises INSUFFICIENT_STOCK if a component is short — the
  // transaction then rolls back, so partial consumption is impossible.
  const inputMovementIds: number[] = [];
  for (const line of bom) {
    const needed = Number(line.qty_per_unit) * orderQty;
    const { movementId } = await applyMovement(
      {
        productId: line.component_product_id,
        fromLocationId: order.location_id,
        toLocationId: null,
        qty: needed,
        reason: 'production_input',
        actorUserId,
        productionOrderId: order.id,
      },
      tx,
    );
    inputMovementIds.push(movementId);
  }

  // Produce the output into the target location.
  const { movementId: outputMovementId } = await applyMovement(
    {
      productId: order.product_id,
      fromLocationId: null,
      toLocationId: order.target_location_id,
      qty: orderQty,
      reason: 'production_output',
      actorUserId,
      productionOrderId: order.id,
    },
    tx,
  );

  return { inputMovementIds, outputMovementId };
}

/**
 * Transition a production order to `done`, running the atomic BOM flow.
 * Opens its own transaction unless one is supplied. The order must currently
 * be `new` or `in_progress`.
 */
export async function finishProductionOrder(
  orderId: number,
  actorUserId: number | null,
  tx?: TxClient,
): Promise<ProductionOrderRow> {
  const run = async (client: TxClient): Promise<ProductionOrderRow> => {
    // Lock the order row so two concurrent "done" calls serialize (no double
    // BOM consumption).
    const { rows } = await client.query<ProductionOrderRow>(
      `SELECT ${PRODUCTION_ORDER_COLUMNS} FROM production_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = rows[0];
    if (order === undefined) {
      throw AppError.notFound('Production order not found.');
    }
    if (order.status === 'done') {
      // Idempotent: already done — return as-is, do not consume BOM again.
      return order;
    }
    if (order.status !== 'new' && order.status !== 'in_progress') {
      throw AppError.validation(
        `Cannot finish a production order in status "${order.status}".`,
      );
    }

    await consumeBomAndProduce(client, order, actorUserId);

    const { rows: updated } = await client.query<ProductionOrderRow>(
      `UPDATE production_orders SET status = 'done', done_at = now()
       WHERE id = $1
       RETURNING ${PRODUCTION_ORDER_COLUMNS}`,
      [orderId],
    );
    const result = updated[0];
    if (result === undefined) {
      throw AppError.internal('Production order done update returned no row.');
    }

    await writeAudit(client, {
      actorUserId,
      action: 'production_order.done',
      entity: 'production_orders',
      entityId: orderId,
      payload: { product_id: order.product_id, qty: Number(order.qty) },
    });

    return result;
  };

  return tx !== undefined ? run(tx) : withTransaction(run);
}
