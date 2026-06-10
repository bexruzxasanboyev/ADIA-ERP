/**
 * Variant A + mini-xarita — the THREE-GROUP grammar of every frontline feed.
 *
 * Each role's «Ishlarim» screen is ONE feed of cards in three fixed groups:
 *
 *   YANGI      — cards awaiting MY accept/decision (Qabul qilish / Rad …).
 *   JARAYONDA  — accepted / in-flight (watch cards with a chain strip +
 *                wait_reason, or the production «Manba reja» step).
 *   TAYYOR     — the final action (Jo'natish / Qabul qildim / Tayyor —
 *                skladga …).
 *
 * The mapping of a row → bucket is extracted here as PURE functions (no React,
 * no fetch) so each role's inbox stays presentation-only and the grammar is
 * unit-testable without jsdom. A `null` return means "this row does not appear
 * on the feed at all".
 */
import { pipelineStageOf } from '@/lib/pipeline';
import {
  isProductionInputWaiting,
  isRawPosterWaiting,
  type FlowRequest,
} from '@/lib/replenishmentFlow';
import {
  TERMINAL_REPLENISHMENT_STATUSES,
  type PurchaseOrder,
  type ReplenishmentRequest,
} from '@/lib/types';

export type WorkBucket = 'yangi' | 'jarayonda' | 'tayyor';

/** The three groups in feed order, with their Uzbek labels. */
export const WORK_BUCKETS: readonly { key: WorkBucket; label: string }[] = [
  { key: 'yangi', label: 'Yangi' },
  { key: 'jarayonda', label: 'Jarayonda' },
  { key: 'tayyor', label: 'Tayyor' },
];

/** Generic id-desc partition of rows into the three buckets. */
export function partitionByBucket<T extends { id: number }>(
  rows: readonly T[],
  bucketOf: (row: T) => WorkBucket | null,
): Record<WorkBucket, T[]> {
  const out: Record<WorkBucket, T[]> = { yangi: [], jarayonda: [], tayyor: [] };
  for (const row of rows) {
    const bucket = bucketOf(row);
    if (bucket !== null) out[bucket].push(row);
  }
  for (const key of Object.keys(out) as WorkBucket[]) {
    out[key].sort((a, b) => b.id - a.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ishlab chiqarish (отдел) — caller pre-filters to "my production flow" rows.
// ---------------------------------------------------------------------------

/** Statuses where production is actively involved in MAKING the request. */
const PRODUCTION_MAKING_STATUSES = new Set<string>([
  'CHECK_PRODUCTION_INPUT',
  'CREATE_PURCHASE_ORDER',
  'CREATE_PRODUCTION_ORDER',
  'PRODUCING',
]);

/**
 *   YANGI     — at the отдел gate (assigned, not yet accepted).
 *   JARAYONDA — accepted, NO zayafka yet: waiting on raw materials
 *               (CREATE_PURCHASE_ORDER) or awaiting the «Manba reja» step.
 *   TAYYOR    — the zayafka exists → the «Tayyor — skladga» finishing action.
 *   null      — DONE_TO_WAREHOUSE / shipped / closed — off the отдел's feed.
 */
export function productionBucketOf(req: FlowRequest): WorkBucket | null {
  if (isProductionInputWaiting(req)) return 'yangi';
  if (!PRODUCTION_MAKING_STATUSES.has(req.status)) return null;
  return req.production_order_id != null ? 'tayyor' : 'jarayonda';
}

/**
 * A JARAYONDA production card that is BLOCKED (no button): the zayafka cannot
 * open until the raw-material purchase is received. Everything else in
 * Jarayonda gets the «Manba reja» step as its one action.
 */
export function isProductionWaitingRaw(req: FlowRequest): boolean {
  return (
    req.production_order_id == null && req.status === 'CREATE_PURCHASE_ORDER'
  );
}

// ---------------------------------------------------------------------------
// Markaziy sklad — caller passes the merged incoming board (target = central).
// ---------------------------------------------------------------------------

/**
 *   YANGI     — a store order awaiting central's send decision (Jo'natish/Rad).
 *   JARAYONDA — shipped to the store, awaiting the store's receive (watch).
 *   TAYYOR    — a production arrival to confirm-receive (Qabul qildim).
 *   null      — everything else (closed, central's own outgoing, …).
 */
export function centralBucketOf(
  req: FlowRequest,
  centralId: number | null,
): WorkBucket | null {
  // DONE_TO_WAREHOUSE resolves to the kutuvda stage, so test it FIRST.
  if (req.status === 'DONE_TO_WAREHOUSE') return 'tayyor';
  const stage = pipelineStageOf(req);
  if (stage === 'kutuvda') {
    // Central's own raised request is not an incoming store order.
    if (centralId !== null && req.requester_location_id === centralId) {
      return null;
    }
    return 'yangi';
  }
  if (stage === 'yuborilgan') return 'jarayonda';
  return null;
}

// ---------------------------------------------------------------------------
// Do'kon — scope = the viewer's store location ids.
// ---------------------------------------------------------------------------

/**
 *   JARAYONDA — my open outgoing order, still in flight (watch + chain strip).
 *   TAYYOR    — the shipment arrived (reserved-shipped) → «Qabul qilish».
 *   null      — not mine / terminal. (A store feed has no YANGI source today —
 *               nothing asks the store to accept a decision.)
 */
export function storeBucketOf(
  req: ReplenishmentRequest,
  storeScope: ReadonlySet<number>,
): WorkBucket | null {
  if (!storeScope.has(req.requester_location_id)) return null;
  const flow = req as FlowRequest;
  // Reserved-shipped: CLOSED, no closure side-state, fulfiller stamped — the
  // goods are at the door (mirrors the legacy «Qabul qiluvchi» predicate).
  if (
    req.status === 'CLOSED' &&
    flow.closure_reason == null &&
    flow.fulfiller_accepted_at != null
  ) {
    return 'tayyor';
  }
  if (TERMINAL_REPLENISHMENT_STATUSES.includes(req.status)) return null;
  return 'jarayonda';
}

// ---------------------------------------------------------------------------
// Homashyo ombori — caller pre-filters to rows targeting the raw warehouse;
// purchase orders bucket separately (two entity kinds, one feed).
// ---------------------------------------------------------------------------

/**
 *   YANGI     — an incoming department request awaiting the keeper's accept.
 *   JARAYONDA — accepted, waiting on the Poster Поставка sync (watch card).
 *   null      — everything else (the engine carries it onward).
 */
export function rawRequestBucketOf(req: FlowRequest): WorkBucket | null {
  if (
    !req.fulfiller_accepted_at &&
    (req.status === 'NEW' || req.status === 'CHECK_STORE_SUPPLIER')
  ) {
    return 'yangi';
  }
  if (isRawPosterWaiting(req, pipelineStageOf(req))) return 'jarayonda';
  return null;
}

/**
 *   YANGI  — a draft PO awaiting the keeper's signature (ikkinchi imzo).
 *   TAYYOR — an approved PO whose goods arrive at the door → receive.
 *   null   — received / cancelled / rejected, or already keeper-signed drafts
 *            (waiting on the manager — not this keeper's move).
 */
export function rawPurchaseOrderBucketOf(
  order: Pick<PurchaseOrder, 'status' | 'keeper_approved_by'>,
): WorkBucket | null {
  if (order.status === 'draft') {
    return order.keeper_approved_by === null ? 'yangi' : null;
  }
  if (order.status === 'approved') return 'tayyor';
  return null;
}
