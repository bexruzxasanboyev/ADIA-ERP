/**
 * Replenishment write-action helpers for the MANUAL central-warehouse →
 * production flow (and the changed accept-central behaviour).
 *
 * These wrap `apiRequest` for the endpoints the central warehouse manager
 * drives by hand:
 *   1. accept-central       — ship from central stock IF enough (no cascade).
 *   2. to-production        — manually hand a request off to production.
 *   3. receive-from-production — confirm produced goods landed at central.
 *   4. ship-to-store        — forward the sound qty central → store.
 *
 * RBAC: every endpoint is `central_warehouse_manager`, own central warehouse
 * only (the backend scopes it). `:id` is the replenishment_request id.
 *
 * Kept in one module (rather than inlined per page) so the inbox and the
 * "Chiqgan" tracker share the exact same contract — see the typed envelopes in
 * `lib/types.ts`.
 */
import { apiRequest } from './api-client';
import type {
  AcceptCentralResponse,
  FulfillResponse,
  ReceiveFromProductionResponse,
  ReplenishmentRequest,
  ShipToStoreResponse,
  ToProductionResponse,
} from './types';

/**
 * Accept an incoming store request and ship it from central stock.
 *
 * Ships ONLY when the central warehouse holds enough; when short it does NOT
 * cascade to production — `shipped` comes back `false` with a `reason`, and the
 * request stays at `CHECK_STORE_SUPPLIER`. Callers must then offer
 * {@link sendToProduction} so the manager is never stuck.
 */
export function acceptCentral(
  id: number,
  centralId: number,
): Promise<AcceptCentralResponse> {
  return apiRequest<AcceptCentralResponse>(
    `/api/replenishment/${id}/accept-central`,
    { method: 'POST', body: { location_id: centralId } },
  );
}

/**
 * Manually send a request to production (the central manager's "Ishlab
 * chiqarishga yuborish"). Allowed from `NEW` or `CHECK_STORE_SUPPLIER`. On
 * success the response `request.route_to_production_manual` is `true`; the
 * status advances to `CREATE_PRODUCTION_ORDER` / `CREATE_PURCHASE_ORDER`, or
 * stays `CHECK_PRODUCTION_INPUT` with `advanced: false` when there is no
 * production topology / BOM. A wrong status yields a 409 `INVALID_TRANSITION`
 * (surfaced as an `ApiError` for the caller to toast).
 */
export function sendToProduction(
  id: number,
  centralId: number,
): Promise<ToProductionResponse> {
  return apiRequest<ToProductionResponse>(
    `/api/replenishment/${id}/to-production`,
    { method: 'POST', body: { location_id: centralId } },
  );
}

/**
 * Confirm the produced goods arrived at central (the "Qabul qildim" step).
 * Allowed only from `DONE_TO_WAREHOUSE`; idempotent. `brak_reason` is REQUIRED
 * by the backend when `brak_qty > 0`. The goods are already physically at
 * central (no stock re-add); `brak_qty > 0` is written off. Status →
 * `SHIP_TO_REQUESTER`.
 */
export function receiveFromProduction(
  id: number,
  body: { brak_qty?: number; brak_reason?: string },
): Promise<ReceiveFromProductionResponse> {
  return apiRequest<ReceiveFromProductionResponse>(
    `/api/replenishment/${id}/receive-from-production`,
    { method: 'POST', body },
  );
}

/**
 * Forward the sound qty central → store (the "Do'konga yuborish" step).
 * Allowed only from `SHIP_TO_REQUESTER`. Status → `CLOSED`.
 */
export function shipToStore(id: number): Promise<ShipToStoreResponse> {
  return apiRequest<ShipToStoreResponse>(
    `/api/replenishment/${id}/ship-to-store`,
    { method: 'POST', body: {} },
  );
}

/**
 * PARTIAL FULFILMENT of a store request from central stock (the new "Qabul
 * qilish" fulfilment modal — owner's corrected single-flow logic).
 *
 * `ship_qty` is what the manager confirms to send NOW (auto-filled to
 * `min(needed, available)`, capped at on-hand). The backend ships that part
 * to the store (→ «Yuborilgan») and auto-raises a production request for any
 * shortfall (→ «So'ralgan»). Omitting `ship_qty` ships the full available
 * amount. `:id` is the store request's id. RBAC: own central warehouse only.
 */
export function fulfillRequest(
  id: number,
  body: { location_id: number; ship_qty?: number; note?: string },
): Promise<FulfillResponse> {
  return apiRequest<FulfillResponse>(`/api/replenishment/${id}/fulfill`, {
    method: 'POST',
    body,
  });
}

/**
 * `POST /api/replenishment/:id/accept-fulfiller` envelope (phase F-G, FROZEN
 * contract). The operator of the PINNED target location accepts an incoming
 * request. When the target holds stock the engine ships immediately
 * (`shipped: true`); a `raw_warehouse` target instead HOLDS (`shipped: false`)
 * until the Поставка syncs from Poster and the engine auto-ships. RBAC:
 * operator of the pinned target location; PM → 403.
 */
export interface AcceptFulfillerResponse {
  request: ReplenishmentRequest;
  shipped: boolean;
}

/** `POST /api/replenishment/:id/reject-fulfiller` envelope (phase F-G). */
export interface RejectFulfillerResponse {
  request: ReplenishmentRequest;
}

/**
 * Accept an incoming PINNED-target request as its fulfiller (phase F-G).
 * `:id` is the replenishment_request id. RBAC: operator of the pinned target
 * location only; PM is 403 (read-and-recommend).
 */
export function acceptFulfiller(id: number): Promise<AcceptFulfillerResponse> {
  return apiRequest<AcceptFulfillerResponse>(
    `/api/replenishment/${id}/accept-fulfiller`,
    { method: 'POST', body: {} },
  );
}

/** Reject an incoming PINNED-target request as its fulfiller (phase F-G). */
export function rejectFulfiller(
  id: number,
  reason?: string,
): Promise<RejectFulfillerResponse> {
  return apiRequest<RejectFulfillerResponse>(
    `/api/replenishment/${id}/reject-fulfiller`,
    { method: 'POST', body: { reason } },
  );
}

/**
 * Accept an incoming INTERNAL buffer request as its fulfiller — the
 * sex_storage-requester (B-cycle) variant of {@link acceptFulfiller}. Same
 * shape; targets `POST /:id/accept-internal`. RBAC: operator of the pinned
 * sex_storage; PM → 403.
 */
export function acceptInternal(id: number): Promise<AcceptFulfillerResponse> {
  return apiRequest<AcceptFulfillerResponse>(
    `/api/replenishment/${id}/accept-internal`,
    { method: 'POST', body: {} },
  );
}

/** Reject an incoming INTERNAL buffer request (`POST /:id/reject-internal`). */
export function rejectInternal(
  id: number,
  reason?: string,
): Promise<RejectFulfillerResponse> {
  return apiRequest<RejectFulfillerResponse>(
    `/api/replenishment/${id}/reject-internal`,
    { method: 'POST', body: { reason } },
  );
}

/** `POST /api/replenishment` envelope (single-request create — 201). */
interface CreateReplenishmentResponse {
  request: ReplenishmentRequest;
}

/**
 * Replenish the central warehouse's OWN stock from production in one step
 * (the Mahsulotlar card "Ishlab chiqarishga yuborish"):
 *
 *   1. `POST /api/replenishment` with `requester_location_id = <centralId>`
 *      raises a production request for `(product, central)`. The backend
 *      dedupes against invariant 2 — a still-open request for the pair yields
 *      a 409 `OPEN_REQUEST_EXISTS` (surfaced to the caller as an `ApiError`).
 *   2. The returned `request.id` is then routed via {@link sendToProduction}
 *      so it enters the CHECK_PRODUCTION_INPUT → PRODUCING chain and shows up
 *      under So'rovlar → Chiqgan.
 *
 * Returns the to-production routing envelope.
 */
export async function requestCentralProduction(
  centralId: number,
  productId: number,
  qtyNeeded: number,
): Promise<ToProductionResponse> {
  const created = await apiRequest<CreateReplenishmentResponse>(
    '/api/replenishment',
    {
      method: 'POST',
      body: {
        product_id: productId,
        requester_location_id: centralId,
        qty_needed: qtyNeeded,
      },
    },
  );
  return sendToProduction(created.request.id, centralId);
}
