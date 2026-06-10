/**
 * Production-order write helpers — the отдел operator's «Tayyorga o'tkazish»
 * (phase F-Q §1).
 *
 * `lib/types.ts` is frozen (edited in parallel), so the NEW shapes the
 * `GET /api/replenishment/:id` envelope grew — the linked production order and
 * the related purchase orders — live here as an EXTENSION of `ReplenishmentDetail`.
 * Every added field is OPTIONAL on the wire so a payload that predates the
 * backend contract reads as `undefined` and the modal degrades null-safe
 * (no production-order section, no «Bog'liq xaridlar» section) until it lands.
 *
 * PINNED backend contract (phase F-Q):
 *   - `GET /api/replenishment/:id` gains
 *       `production_order: { id, status, qty, location_id } | null`
 *       `purchase_orders: Array<{ id, status, qty, product_id, product_name,
 *                                 product_unit, created_at }>`
 *   - `PATCH /api/production-orders/:id` body `{ status: 'in_progress'|'done' }`
 *       → `200 { production_order }`. RBAC: the row's отдел operator only; PM /
 *       a foreign operator → 403. `done` finishes the job and the linked
 *       replenishment request advances to the Tayyor column.
 */
import { apiRequest } from './api-client';
import type {
  ProductionOrderStatus,
  PurchaseOrderStatus,
  ReplenishmentDetail,
  Unit,
} from './types';

/**
 * The compact production-order view the detail envelope embeds (phase F-Q §1):
 * just enough to render the «Ishlab chiqarish zayafkasi» strip + scope the
 * action buttons to the row's отдел (`location_id`).
 */
export interface DetailProductionOrder {
  id: number;
  status: ProductionOrderStatus;
  qty: number;
  location_id: number;
}

/**
 * One related purchase order embedded in the detail envelope (phase F-Q §2):
 * the «Bog'liq xaridlar» control surface the отдел tracks (read-only — the
 * two-step approval lives with the raw side).
 */
export interface DetailPurchaseOrder {
  id: number;
  status: PurchaseOrderStatus;
  qty: number;
  product_id: number;
  product_name: string;
  product_unit: Unit;
  created_at: string;
}

/**
 * `GET /api/replenishment/:id` envelope WIDENED with the phase-F-Q fields.
 * Structural superset of {@link ReplenishmentDetail}; both new fields are
 * optional + null-safe so the modal compiles and degrades before the backend
 * contract is live. Read via `useApiQuery<ReplenishmentDetailExt>(…)`.
 */
export interface ReplenishmentDetailExt extends ReplenishmentDetail {
  /** The linked making order, or `null`/absent when none exists yet. */
  production_order?: DetailProductionOrder | null;
  /** Related purchase orders (raw side); `[]`/absent when none. */
  purchase_orders?: DetailPurchaseOrder[];
}

/** `PATCH /api/production-orders/:id` envelope (phase F-Q §1, PINNED). */
export interface PatchProductionOrderResponse {
  production_order: DetailProductionOrder;
}

/**
 * Advance a production order's status (phase F-Q §1). `'in_progress'` starts
 * the job; `'done'` finishes it — the backend decrements raw by the BOM,
 * increments the сех storage / central, and advances the linked replenishment
 * request to the Tayyor column atomically. `:id` is the production_orders id.
 * RBAC: operator of the order's `location_id` only; PM / a foreign operator → 403.
 */
export function patchProductionOrderStatus(
  id: number,
  status: Extract<ProductionOrderStatus, 'in_progress' | 'done'>,
): Promise<PatchProductionOrderResponse> {
  return apiRequest<PatchProductionOrderResponse>(
    `/api/production-orders/${id}`,
    { method: 'PATCH', body: { status } },
  );
}
