/**
 * Journey derivation — the server-computed mini chain-map every replenishment
 * request carries to the UI ("Variant A + mini-map", owner-approved 2026-06-10).
 *
 * The frontend renders cards like  Do'kon ●─● Markaz ●─○ Sex ─○ Ombor  plus a
 * plain-Uzbek wait reason WITHOUT any UI-side status inference: this module is
 * the single source of truth for "where are the goods now and what are we
 * waiting for".
 *
 * Contract (PINNED — agreed with the frontend; do not change without flagging):
 *
 *   journey: {
 *     stations: [{ location_id, name, type, state }],  // product-flow order,
 *                                                      // source -> requester
 *     current_index: number,                           // the 'current' station
 *     wait_reason: string | null                       // plain-Uzbek one-liner
 *   }
 *
 * Derivation is PURE (`deriveJourney`) over columns the list/single/tree/incoming
 * queries already select, plus AT MOST one batched extra query per endpoint
 * (`fetchOpenChildInfo` — the first open child per parent, for the
 * "{producer}dan {product} kutilmoqda" reason). No N+1.
 */
import { query } from '../db/index.js';

// -----------------------------------------------------------------------------
// Types (the response contract)
// -----------------------------------------------------------------------------

export type JourneyStationType =
  | 'store'
  | 'central_warehouse'
  | 'production'
  | 'sex_storage'
  | 'raw_warehouse';

export type JourneyStationState = 'done' | 'current' | 'pending';

export type JourneyStation = {
  /** NULL for a logical station not yet resolved (e.g. untargeted "Markaz"). */
  location_id: number | null;
  name: string;
  type: JourneyStationType;
  state: JourneyStationState;
};

export type Journey = {
  /** Ordered in PRODUCT-FLOW direction (source -> requester), 2..4 stations. */
  stations: JourneyStation[];
  current_index: number;
  wait_reason: string | null;
};

/** The subset of a request row `deriveJourney` needs — all columns the list /
 *  single / tree / incoming queries already select (no extra per-row work). */
export type JourneyInput = {
  status: string;
  closure_reason: string | null;
  requester_location_id: number;
  requester_location_name: string | null;
  requester_location_type: string | null;
  target_location_id: number | null;
  target_location_name: string | null;
  target_location_type: string | null;
  production_location_id: number | null;
  production_location_name: string | null;
  production_order_id: number | null;
  purchase_order_id: number | null;
  route_to_production_manual: boolean;
};

/** The first OPEN child sub-request of a parent — feeds the
 *  "{producer}dan {product} kutilmoqda" wait reason. */
export type OpenChildInfo = {
  child_request_id: number;
  product_name: string;
  producer_name: string | null;
};

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

const TERMINAL = new Set(['CLOSED', 'CANCELLED']);

/** Statuses in which the request is physically AT / owned by production. */
const PRODUCTION_STATES = new Set([
  'CHECK_PRODUCTION_INPUT',
  'CREATE_PURCHASE_ORDER',
  'CREATE_PRODUCTION_ORDER',
  'PRODUCING',
]);

/** Coerce a raw `locations.type` into the journey station-type union. The
 *  legacy 'supply' enum value maps to 'sex_storage' (migration 0022 moved the
 *  supply depts there); anything unknown falls back to the given default. */
function toStationType(raw: string | null, fallback: JourneyStationType): JourneyStationType {
  switch (raw) {
    case 'store':
    case 'central_warehouse':
    case 'production':
    case 'sex_storage':
    case 'raw_warehouse':
      return raw;
    case 'supply':
      return 'sex_storage';
    default:
      return fallback;
  }
}

// -----------------------------------------------------------------------------
// deriveJourney — pure, deterministic
// -----------------------------------------------------------------------------

/**
 * Build the journey for ONE request row.
 *
 * Station path (2..3 stations, product-flow direction, requester last):
 *   - production station — only when the request is production-routed (a
 *     production order exists, the manual to-production flag is set, or the
 *     status sits in a production state with a resolved production location)
 *     AND it is distinct from the target / requester;
 *   - fulfiller station — the pinned target when set; when the target is not
 *     yet resolved, a LOGICAL station (location_id=null): "Markaz" for a store
 *     requester, "Ombor" for an internal (sex / production) requester. Omitted
 *     when production ships straight to an internal requester.
 *   - requester station — always last.
 *
 * NOTE (flagged in the contract report): the raw warehouse appears as a station
 * only when it IS the fulfiller (target) of THIS request; a store request
 * waiting on a purchase order expresses that via `wait_reason`
 * («Xom-ashyo kutilmoqda (xarid #N)») instead of a 4th station.
 */
export function deriveJourney(row: JourneyInput, openChild?: OpenChildInfo | null): Journey {
  const requesterType = toStationType(row.requester_location_type, 'store');
  const requester: Omit<JourneyStation, 'state'> = {
    location_id: row.requester_location_id,
    name: row.requester_location_name ?? "So'rovchi",
    type: requesterType,
  };

  // --- production station -----------------------------------------------------
  const productionRouted =
    row.production_location_id !== null &&
    (row.production_order_id !== null ||
      row.route_to_production_manual ||
      PRODUCTION_STATES.has(row.status) ||
      row.status === 'DONE_TO_WAREHOUSE');
  const productionDistinct =
    productionRouted &&
    row.production_location_id !== row.target_location_id &&
    row.production_location_id !== row.requester_location_id;
  const production: Omit<JourneyStation, 'state'> | null = productionDistinct
    ? {
        location_id: row.production_location_id,
        name: row.production_location_name ?? 'Sex',
        type: 'production',
      }
    : null;

  // --- fulfiller (target) station ----------------------------------------------
  let fulfiller: Omit<JourneyStation, 'state'> | null = null;
  if (row.target_location_id !== null && row.target_location_id !== row.requester_location_id) {
    fulfiller = {
      location_id: row.target_location_id,
      name: row.target_location_name ?? 'Markaz',
      type: toStationType(row.target_location_type, 'central_warehouse'),
    };
  } else if (row.target_location_id === null) {
    if (requesterType === 'store') {
      // A store is always fed by the central warehouse.
      fulfiller = { location_id: null, name: 'Markaz', type: 'central_warehouse' };
    } else if (production === null) {
      // An internal (sex / sex_storage / central) request with no pinned target
      // and no production leg — the natural source is the raw warehouse.
      fulfiller = { location_id: null, name: 'Ombor', type: 'raw_warehouse' };
    }
    // else: production ships straight to the internal requester — 2 stations.
  }

  const path: Omit<JourneyStation, 'state'>[] = [];
  if (production !== null) path.push(production);
  if (fulfiller !== null) path.push(fulfiller);
  path.push(requester);
  if (path.length === 1) {
    // Degenerate row (target == requester, no production) — keep the 2-station
    // minimum with a logical source so the mini-map always has a chain.
    path.unshift(
      requesterType === 'store'
        ? { location_id: null, name: 'Markaz', type: 'central_warehouse' }
        : { location_id: null, name: 'Ombor', type: 'raw_warehouse' },
    );
  }

  const lastIdx = path.length - 1;
  const productionIdx = production !== null ? 0 : null;
  const fulfillerIdx = fulfiller !== null ? (production !== null ? 1 : 0) : null;

  // --- current station ----------------------------------------------------------
  const terminal =
    row.status === 'CANCELLED' || (row.status === 'CLOSED' && row.closure_reason !== null);
  let currentIndex: number;
  if (terminal) {
    // Terminal — every station done; current_index points at the requester.
    currentIndex = lastIdx;
  } else if (row.status === 'CLOSED') {
    // CLOSED w/o closure_reason — shipped, in transit / awaiting the requester's
    // own accept: the goods sit at the requester station.
    currentIndex = lastIdx;
  } else if (row.status === 'SHIP_TO_REQUESTER' || row.status === 'DONE_TO_WAREHOUSE') {
    // Goods at the station just before the requester (ready to forward).
    currentIndex = Math.max(lastIdx - 1, 0);
  } else if (PRODUCTION_STATES.has(row.status)) {
    currentIndex = productionIdx ?? fulfillerIdx ?? 0;
  } else {
    // NEW / CHECK_STORE_SUPPLIER — waiting at the fulfiller.
    currentIndex = fulfillerIdx ?? 0;
  }

  const stations: JourneyStation[] = path.map((s, i) => ({
    ...s,
    state: terminal ? 'done' : i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'pending',
  }));

  // --- wait reason ----------------------------------------------------------------
  // Only for states where the VIEWER cannot act and waits on someone else.
  let waitReason: string | null = null;
  if (!terminal && !TERMINAL.has(row.status)) {
    if (openChild != null) {
      const producer = openChild.producer_name ?? "Ta'minotchi";
      waitReason = `${producer}dan ${openChild.product_name} kutilmoqda`;
    } else if (row.status === 'CREATE_PURCHASE_ORDER') {
      waitReason =
        row.purchase_order_id !== null
          ? `Xom-ashyo kutilmoqda (xarid #${row.purchase_order_id})`
          : 'Xom-ashyo kutilmoqda';
    } else if (row.status === 'NEW' || row.status === 'CHECK_STORE_SUPPLIER') {
      const fulfillerName = fulfiller?.name ?? 'Markaz';
      waitReason = `${fulfillerName} tasdig'i kutilmoqda`;
    }
    // PRODUCING / CREATE_PRODUCTION_ORDER / DONE_TO_WAREHOUSE / SHIP_TO_REQUESTER
    // are actively producible / actionable — wait_reason stays null.
  }

  return { stations, current_index: currentIndex, wait_reason: waitReason };
}

// -----------------------------------------------------------------------------
// Batched enrichment — ONE extra query per endpoint, never N+1
// -----------------------------------------------------------------------------

/**
 * The FIRST open (non-terminal) child sub-request per parent, with the child's
 * product name and producer name (pinned target, else the production-order
 * location, else the product's workshop). One query for the whole id set.
 */
export async function fetchOpenChildInfo(
  parentIds: readonly number[],
): Promise<Map<number, OpenChildInfo>> {
  const map = new Map<number, OpenChildInfo>();
  if (parentIds.length === 0) return map;
  const { rows } = await query<{
    parent_request_id: number;
    id: number;
    product_name: string;
    producer_name: string | null;
  }>(
    `SELECT DISTINCT ON (c.parent_request_id)
            c.parent_request_id,
            c.id,
            p.name AS product_name,
            COALESCE(tl.name, pol.name, wl.name) AS producer_name
       FROM replenishment_requests c
       JOIN products p ON p.id = c.product_id
       LEFT JOIN locations tl ON tl.id = c.target_location_id
       LEFT JOIN production_orders po ON po.id = c.production_order_id
       LEFT JOIN locations pol ON pol.id = po.location_id
       LEFT JOIN locations wl ON wl.id = p.workshop_location_id
      WHERE c.parent_request_id = ANY($1::bigint[])
        AND c.status NOT IN ('CLOSED', 'CANCELLED')
      ORDER BY c.parent_request_id, c.id ASC`,
    [parentIds as number[]],
  );
  for (const r of rows) {
    map.set(Number(r.parent_request_id), {
      child_request_id: Number(r.id),
      product_name: r.product_name,
      producer_name: r.producer_name,
    });
  }
  return map;
}

/**
 * Attach a `journey` to every row of a list response. Exactly ONE extra query
 * (`fetchOpenChildInfo` over the non-terminal ids); everything else is the pure
 * derivation over already-selected columns.
 */
export async function attachJourneys<T extends JourneyInput & { id: number }>(
  rows: readonly T[],
): Promise<(T & { journey: Journey })[]> {
  if (rows.length === 0) return [];
  const openIds = rows
    .filter((r) => !TERMINAL.has(r.status))
    .map((r) => Number(r.id));
  const children = openIds.length > 0 ? await fetchOpenChildInfo(openIds) : new Map<number, OpenChildInfo>();
  return rows.map((r) => ({
    ...r,
    journey: deriveJourney(r, children.get(Number(r.id)) ?? null),
  }));
}
