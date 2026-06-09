/**
 * Cross-department flow types + helpers (phase F-E).
 *
 * The owner cannot touch `lib/types.ts` (it is being edited in parallel), so
 * the NEW request-tree / pipeline-stage / closure / origin fields the backend
 * added in F-A/F-D live here as an EXTENSION of `ReplenishmentRequest`. Every
 * field is OPTIONAL on the wire so older payloads (and the `ReplenishmentRequest`
 * rows the rest of the app already builds) stay strict-type-safe — a row that
 * predates the columns reads as `undefined` and every helper degrades to a sane
 * default (depth 0, origin unknown, no closure badge, no children).
 *
 * Mirrors the PINNED backend contracts:
 *   - 0058 `pipeline_stage` (already shipped) — see {@link PipelineStage}.
 *   - F-A request-tree columns: parent/root/depth/origin/batch_id.
 *   - closure side-states: closure_reason + brak_qty/brak_reason.
 *   - GET /api/replenishment/:id/tree — see {@link RequestTreeResponse}.
 */
import type { ReplenishmentRequest } from './types';

/**
 * How a request was born (F-A `origin` column). Drives the small provenance
 * badge on a request card so a boshliq can tell an auto-scan top-up from a
 * voice order or a recursive sub-request at a glance.
 *
 *   - `scan`      — the min/max scan-cron raised it (qty fell to min).
 *   - `manual`    — a human typed it in a web form.
 *   - `voice`     — a Telegram voice message ("10 napoleon kerak").
 *   - `dialog`    — emitted by the production source-decision dialog.
 *   - `shortfall` — the gap left after a partial fulfilment.
 *   - `buffer`    — the з/г buffer (B-cycle) top-up scan.
 */
export type RequestOrigin =
  | 'scan'
  | 'manual'
  | 'voice'
  | 'dialog'
  | 'shortfall'
  | 'buffer';

/**
 * Closure side-state (F-D `closure_reason`). Only meaningful when the request
 * is in the `yopilgan` stage — it refines WHY it closed so the Yopildi column
 * can render a coloured outcome badge instead of a flat "Yopilgan".
 */
export type ClosureReason =
  | 'accepted_full'
  | 'accepted_partial'
  | 'rejected'
  | 'returned'
  | 'cancelled_by_requester'
  | 'cancelled_by_fulfiller';

/**
 * A replenishment row enriched with the F-A/F-D cross-department flow fields.
 *
 * It is a structural SUPERSET of `ReplenishmentRequest` (every base field is
 * present, untouched), with the new columns added as optional. The whole app
 * already produces `ReplenishmentRequest` values; this type only WIDENS the
 * read surface, so a plain `ReplenishmentRequest` is assignable wherever a
 * `FlowRequest` is expected to be read leniently (the extra fields are simply
 * `undefined`). Use it on the boards so the new badges/chips compile without
 * casting through `any`.
 */
export interface FlowRequest extends ReplenishmentRequest {
  /** Direct parent in the request tree, or `null`/absent for a root. */
  parent_request_id?: number | null;
  /** The tree root (self for a root), or `null`/absent on legacy rows. */
  root_request_id?: number | null;
  /** Depth from the root (0 = root). BOM-capped at 12 on the backend. */
  depth?: number | null;
  /** How the request was created — see {@link RequestOrigin}. */
  origin?: RequestOrigin | null;
  /** Closure side-state; only set in the `yopilgan` stage. */
  closure_reason?: ClosureReason | null;
  /**
   * Number of OPEN child requests this row is waiting on, when the backend
   * cheaply embeds it on the list. Absent on most list payloads — the detail
   * tree is the authoritative source. Drives the "bolalar: N" list chip only
   * when present (we never N+1 the list to compute it).
   */
  open_children_count?: number | null;
}

/** Uzbek labels for the request-origin provenance badge. */
export const REQUEST_ORIGIN_LABELS: Record<RequestOrigin, string> = {
  scan: 'Skan',
  manual: 'Qo‘lda',
  voice: 'Ovoz',
  dialog: 'Dialog',
  shortfall: 'Qisman',
  buffer: 'Bufer',
};

/** Badge variant per origin (visual weight on the card). */
export const REQUEST_ORIGIN_VARIANT: Record<
  RequestOrigin,
  'default' | 'outline' | 'secondary' | 'info' | 'warning'
> = {
  scan: 'outline',
  manual: 'secondary',
  voice: 'info',
  dialog: 'info',
  shortfall: 'warning',
  buffer: 'outline',
};

/** Uzbek labels for the closure-reason outcome badge (Yopildi column). */
export const CLOSURE_REASON_LABELS: Record<ClosureReason, string> = {
  accepted_full: 'Qabul',
  accepted_partial: 'Qisman',
  rejected: 'Rad',
  returned: 'Qaytarildi',
  cancelled_by_requester: 'Bekor',
  cancelled_by_fulfiller: 'Bekor',
};

/** Badge variant per closure reason (green accept, red reject, …). */
export const CLOSURE_REASON_VARIANT: Record<
  ClosureReason,
  'success' | 'warning' | 'danger' | 'secondary'
> = {
  accepted_full: 'success',
  accepted_partial: 'warning',
  rejected: 'danger',
  returned: 'warning',
  cancelled_by_requester: 'secondary',
  cancelled_by_fulfiller: 'secondary',
};

// ---------------------------------------------------------------------------
// GET /api/replenishment/:id/tree — PINNED, FROZEN shape (F-D, parallel build).
// `nodes` is every descendant FLAT, ordered by (depth, id); nest client-side
// via `parent_request_id`. A 404 (endpoint not yet live) MUST degrade
// gracefully — hide the tree section.
// ---------------------------------------------------------------------------

/** One node row in the request tree — a full request row + flow fields. */
export interface RequestTreeNode extends FlowRequest {
  /** Number of open waiters linked to this node (kutuvchilar: N). */
  waiters_count?: number | null;
}

/** A (child → waiter) edge from the `request_waiters` table. */
export interface RequestWaiterEdge {
  child_request_id: number;
  waiter_request_id: number;
}

/** `GET /api/replenishment/:id/tree` envelope (PINNED). */
export interface RequestTreeResponse {
  root: RequestTreeNode;
  /** All descendants, FLAT, ordered by (depth, id). */
  nodes: RequestTreeNode[];
  waiters: RequestWaiterEdge[];
}

// ---------------------------------------------------------------------------
// GET /api/production-plan + POST /api/production-plan/execute — PINNED (F-B).
// The "Manba reja" source-plan: per-component status + a recommended action,
// then a single transactional execute. RBAC: production_manager (own sex) + PM
// read; PM gets 403 on execute (read-and-recommend).
// ---------------------------------------------------------------------------

/**
 * What kind of component a plan line is — drives the kind chip + which actions
 * are offered:
 *   - `raw`           — raw material (Xom-ashyo) → transfer / purchase.
 *   - `semi_own`      — a semi this very sex makes → use_ready / make.
 *   - `semi_inplace`  — a semi with no producer (workshop NULL) → made in place.
 *   - `semi_producer` — a semi another sex makes (krem→Qaymoq) → use_ready (at
 *                       producer) / transfer / order (sub-request to producer).
 */
export type PlanLineKind = 'raw' | 'semi_own' | 'semi_inplace' | 'semi_producer';

/**
 * A per-line action / suggestion. `suggested` is the backend's pre-selected
 * recommendation; the operator may switch to any action the kind allows.
 *   - `use_ready` — consume an already-ready semi (own or producer stock).
 *   - `make`      — start a zagatovka sub-order (0dan).
 *   - `order`     — raise a sub-request to the producer sex.
 *   - `transfer`  — move raw / producer stock to the production location.
 *   - `purchase`  — raise a purchase order toward the raw warehouse.
 */
export type PlanLineAction =
  | 'use_ready'
  | 'make'
  | 'order'
  | 'transfer'
  | 'purchase';

/** The producer sex of a `semi_producer` line. */
export interface PlanLineProducer {
  location_id: number;
  name: string;
  storage_location_id: number;
}

/** Availability snapshot for a plan line (`null` when not applicable). */
export interface PlanLineAvailability {
  /** On-hand at the source (own/producer sex_storage), or `null`. */
  at_source: number | null;
  /** On-hand at the raw warehouse (raw lines), or `null`. */
  at_raw: number | null;
}

/** One component line of the source plan. */
export interface ProductionPlanLine {
  component_product_id: number;
  name: string;
  type: 'raw' | 'semi' | 'finished';
  unit: string;
  /** Quantity of this component needed for the requested make. */
  need: number;
  kind: PlanLineKind;
  /** The producer sex — present only for `semi_producer` lines. */
  producer?: PlanLineProducer | null;
  available: PlanLineAvailability;
  /** How much is ready to consume right now (caps `use_ready`). */
  qty_ready: number;
  /** Backend-recommended action (pre-selected in the per-line select). */
  suggested: PlanLineAction;
  /** An already-open producer request to merge into, when any. */
  open_request_id?: number | null;
}

/** `GET /api/production-plan?product_id&qty&location_id` envelope (PINNED). */
export interface ProductionPlanResponse {
  product_id: number;
  qty: number;
  location_id: number;
  lines: ProductionPlanLine[];
}

/** One per-line decision posted to execute. */
export interface PlanDecision {
  component_product_id: number;
  action: PlanLineAction;
  /** Partial-use quantity for a `use_ready` action (omit = full `qty_ready`). */
  qty_ready?: number;
}

/** `POST /api/production-plan/execute` request body (PINNED). */
export interface ExecutePlanBody {
  request_id?: number;
  product_id: number;
  qty: number;
  location_id: number;
  decisions: PlanDecision[];
}

/**
 * One executed line in the execute response. The created-document id field
 * VARIES by action (`movement_id` / `production_order_id` / `request_id`);
 * `waiter_linked` / `qty_topped_up` appear only on the OPEN_REQUEST_EXISTS
 * merge path of an `order` action.
 */
export interface ExecutedPlanLine {
  component_product_id: number;
  action: PlanLineAction;
  movement_id?: number;
  production_order_id?: number;
  request_id?: number;
  waiter_linked?: boolean;
  qty_topped_up?: boolean;
}

/** `POST /api/production-plan/execute` envelope (PINNED). */
export interface ExecutePlanResponse {
  executed: ExecutedPlanLine[];
}

/** A node nested into a tree for rendering (root + recursive children). */
export interface NestedTreeNode {
  node: RequestTreeNode;
  children: NestedTreeNode[];
}

/**
 * Nest the flat `root` + `nodes` list into a tree via `parent_request_id`.
 *
 * The backend sends descendants flat (ordered by depth,id); the UI nests them
 * for an indented "So'rovlar daraxti" view. Any node whose parent is missing
 * from the set (shouldn't happen, but be defensive) is attached under the root
 * so it never silently vanishes. Pure — safe to memoise.
 */
export function nestRequestTree(tree: RequestTreeResponse): NestedTreeNode {
  const rootNode: NestedTreeNode = { node: tree.root, children: [] };
  const byId = new Map<number, NestedTreeNode>();
  byId.set(tree.root.id, rootNode);

  // First pass — wrap every descendant so parents exist before we link.
  for (const n of tree.nodes) {
    if (!byId.has(n.id)) byId.set(n.id, { node: n, children: [] });
  }
  // Second pass — link each descendant under its parent (root as fallback).
  for (const n of tree.nodes) {
    const wrapped = byId.get(n.id);
    if (!wrapped) continue;
    const parentId = n.parent_request_id ?? null;
    const parent =
      parentId !== null && byId.has(parentId)
        ? byId.get(parentId)!
        : rootNode;
    if (parent !== wrapped) parent.children.push(wrapped);
  }
  return rootNode;
}
