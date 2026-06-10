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
import { formatQtyUnit } from './format';
import type { LocationType, PipelineStage, ReplenishmentRequest } from './types';

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
  /**
   * The production location the request is ASSIGNED to (phase F-J, PINNED
   * backend contract): `production_orders.location_id` when a making order
   * already exists, else the product's `workshop_location_id`. It is what lets
   * a scoped WORKSHOP manager see a production-bound row (e.g. a central
   * shortfall #34811 in CREATE_PURCHASE_ORDER) on their "Kelgan" board even
   * though the request's `target_location_id` still points at the central
   * warehouse. `production_location_name` (already on `ReplenishmentRequest`)
   * resolves from the same source. Optional + null-safe on the wire: absent
   * reads as "not yet production-assigned" and the row is bucketed purely by
   * `target_location_id` / `requester_location_id` as before.
   */
  production_location_id?: number | null;
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
  /**
   * ISO timestamp the PINNED-target operator accepted the request
   * (`POST /:id/accept-fulfiller` / `accept-internal`), or `null`/absent until
   * then (phase F-G, FROZEN contract). It is what splits the "Kutuvda" column
   * into Kutuvda (not yet accepted) vs. **Tasdiqlandi** (accepted, pre-ship):
   * see {@link kanbanColumnOf}. For a `raw_warehouse` target it ALSO marks the
   * "Poster postavka kutilmoqda" hold — see {@link isRawPosterWaiting}.
   */
  fulfiller_accepted_at?: string | null;
  /**
   * The requester location's type (`store` / `central_warehouse` / `production`
   * / `sex_storage` / `raw_warehouse`), embedded for the route-line caption +
   * role-aware modal actions. Optional on the wire — absent reads as unknown.
   */
  requester_location_type?: LocationType | null;
  /**
   * The target (fulfiller) location's type. Drives the raw-Poster waiting rule
   * and the sex_storage-buffer accept variant (accept-internal vs.
   * accept-fulfiller). Optional on the wire — absent reads as unknown.
   */
  target_location_type?: LocationType | null;
  /**
   * Accepted / returned quantities recorded on the receiver-side flow, surfaced
   * in the detail modal's meta grid. Optional on the wire so older payloads
   * stay strict-type-safe; absent reads as "not yet recorded".
   */
  qty_accepted?: number | null;
  qty_returned?: number | null;
  /** Free-text accept note / reject reason, when the backend embeds it. */
  accept_note?: string | null;
  reject_reason?: string | null;
  /**
   * How much of the request was actually SHIPPED — the shipment movement's qty
   * (phase F-L, PINNED backend contract): `4` when 4 of a 10 kg request was sent
   * and the rest routed to production. Surfaced as the PRIMARY qty chip on the
   * Jo'natildi / Yopildi columns (with a muted `/ qty_needed` suffix when they
   * differ) so a partial ship reads as "what left", not "what was asked". Every
   * other column keeps `qty_needed`. Optional + null-safe on the wire: absent /
   * `null` reads as "nothing shipped yet (or not a ship row)" and the chip falls
   * back to `qty_needed` everywhere — see {@link RequestCard} / the modal header.
   */
  shipped_qty?: number | null;
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
// Kanban v2 — the Jira-like 6-column board (phase F-G). The 5 canonical
// pipeline stages gain a "Tasdiqlandi" lane between Kutuvda and Tayyorlanmoqda,
// because the owner wants the boshliq's ACCEPT to be a visible, distinct stage
// (a pinned-target row that has been accepted but not yet shipped). The column
// is a CLIENT derivation layered on top of `pipelineStageOf` + the FROZEN
// `fulfiller_accepted_at` field — the backend `pipeline_stage` enum is
// unchanged.
// ---------------------------------------------------------------------------

/**
 * One of the six Jira columns. `tasdiqlandi` is UI-only (no backend enum
 * value); every other id is the matching {@link PipelineStage}.
 */
export type KanbanColumn =
  | 'kutuvda'
  | 'tasdiqlandi'
  | 'soralgan'
  | 'qabul_qilingan'
  | 'yuborilgan'
  | 'yopilgan';

/** The six columns in flow order, with their Uzbek labels + accent tokens. */
export const KANBAN_COLUMNS: readonly {
  column: KanbanColumn;
  label: string;
  /** Tailwind background token for the left accent rail + header dot. */
  accent: string;
}[] = [
  { column: 'kutuvda', label: 'Kutuvda', accent: 'bg-warning' },
  { column: 'tasdiqlandi', label: 'Tasdiqlandi', accent: 'bg-info' },
  { column: 'soralgan', label: 'Tayyorlanmoqda', accent: 'bg-info' },
  { column: 'qabul_qilingan', label: 'Tayyor', accent: 'bg-success' },
  { column: 'yuborilgan', label: "Jo‘natildi", accent: 'bg-primary' },
  { column: 'yopilgan', label: 'Yopildi', accent: 'bg-muted-foreground' },
];

/**
 * True when a production-ASSIGNED request is still parked at the отдел gate —
 * it landed on the making sex (`production_location_id != null`) and is in the
 * raw-material check (`status === 'CHECK_PRODUCTION_INPUT'`), but the отдел
 * operator has NOT yet pressed «Qabul qilish» (`fulfiller_accepted_at` is unset)
 * (phase F-L §1, owner: "Kutuvda tushishi kerak edi; qabul qilsa keyin jarayon
 * boshlanishi kerak").
 *
 * In that window the cron HOLDS the row (the PINNED backend contract: no
 * зг-check / transfer / PO until the accept stamps `fulfiller_accepted_at`), so
 * the board must show it as **Kutuvda**, NOT Tayyorlanmoqda — see
 * {@link kanbanColumnFromStage}. The instant the stamp lands the predicate goes
 * false and the existing stage/accept rules carry the row onward
 * (kutuvda+accepted → Tasdiqlandi; the engine moves it to soralgan on its next
 * pass). Total + deterministic: it keys ONLY on already-present null-safe fields,
 * so a legacy row (no `production_location_id`) reads false and buckets exactly
 * as before. Mirrors {@link isRawPosterWaiting}'s shape (a pre-action hold on a
 * specific target class), kept beside it on purpose.
 *
 * Defined over a minimal `Pick` so it stays dependency-free and the caller
 * (which already resolved nothing here — `status` is on the row) passes the row.
 */
export function isProductionInputWaiting(
  req: Pick<
    FlowRequest,
    'production_location_id' | 'status' | 'fulfiller_accepted_at'
  >,
): boolean {
  return (
    req.production_location_id != null &&
    req.status === 'CHECK_PRODUCTION_INPUT' &&
    !req.fulfiller_accepted_at
  );
}

/**
 * Derive the Jira column of a request (phase F-G §2, extended in F-L §1):
 *
 *   yopilgan      → Yopildi
 *   yuborilgan    → Jo'natildi
 *   qabul_qilingan→ Tayyor
 *   production-input gate (not yet accepted) → **Kutuvda** (F-L §1 override)
 *   soralgan      → Tayyorlanmoqda
 *   kutuvda + fulfiller_accepted_at → **Tasdiqlandi**
 *   kutuvda (else)→ Kutuvda
 *
 * Everything routes through {@link pipelineStageOf} first (backend
 * `pipeline_stage`, status fallback), so a row never lands in two columns and
 * legacy rows still bucket sanely.
 *
 * TWO client-only splits layer on top, and they are mutually exclusive by
 * construction:
 *   1. F-L §1 PULL-BACK — a gated production row resolves to `soralgan` via
 *      `pipelineStageOf` (CHECK_PRODUCTION_INPUT), but {@link isProductionInputWaiting}
 *      pulls it BACK to `kutuvda` until the отдел accepts. It can only ever move
 *      a row from soralgan → kutuvda (one step back, deterministic), never
 *      forward, and it requires `!fulfiller_accepted_at`.
 *   2. F-G PUSH-FORWARD — the `kutuvda` + `fulfiller_accepted_at` → `tasdiqlandi`
 *      split, which requires the stamp to be SET.
 * Because (1) needs the stamp UNSET and (2) needs it SET, no row triggers both;
 * applying the pull-back first keeps a freshly-accepted gate row flowing onward
 * by the normal rules.
 *
 * Imported lazily via the caller (`pipeline.ts`) to avoid a cycle — callers
 * pass the already-resolved `stage`.
 */
export function kanbanColumnFromStage(
  stage: PipelineStage,
  req: Pick<
    FlowRequest,
    'production_location_id' | 'status' | 'fulfiller_accepted_at'
  >,
): KanbanColumn {
  // F-L §1: hold a not-yet-accepted production-assigned row in Kutuvda even
  // though its CHECK_PRODUCTION_INPUT status resolves to soralgan.
  if (isProductionInputWaiting(req)) return 'kutuvda';
  if (stage === 'kutuvda' && req.fulfiller_accepted_at) return 'tasdiqlandi';
  return stage;
}

// ---------------------------------------------------------------------------
// Action ownership (phase F-M). Owner feedback: the central and store boards
// showed the SAME two cards and read as "omborlar bitta bo'lib qolibdi" — the
// missing signal was WHOSE MOVE each card waits on. Every column maps to the
// side that must act next; the board (which knows the viewer's side + location
// scope) renders "Harakat sizda" on the viewer's cards and dims the rest with a
// "… kutilmoqda" chip naming the other side.
// ---------------------------------------------------------------------------

/** Which side of the request must act next. */
export type ActionOwner = 'requester' | 'target' | 'production' | 'none';

/**
 * The next-action owner per Jira column:
 *   yopilgan       → none      (terminal)
 *   yuborilgan     → requester (receive/accept the shipment)
 *   qabul_qilingan → target    (forward from the warehouse)
 *   soralgan / tasdiqlandi → production when an отдел is assigned, else target
 *   kutuvda        → production when it is the F-L gate, else target (accept)
 */
export function actionOwnerOf(
  req: Pick<
    FlowRequest,
    'production_location_id' | 'status' | 'fulfiller_accepted_at'
  >,
  column: KanbanColumn,
): ActionOwner {
  switch (column) {
    case 'yopilgan':
      return 'none';
    case 'yuborilgan':
      return 'requester';
    case 'qabul_qilingan':
      return 'target';
    case 'soralgan':
    case 'tasdiqlandi':
      return req.production_location_id != null ? 'production' : 'target';
    case 'kutuvda':
    default:
      return isProductionInputWaiting(req) ? 'production' : 'target';
  }
}

/** Uzbek "waiting on the other side" chip text for a NOT-mine card. */
export function waitingOnLabel(
  req: Pick<
    FlowRequest,
    'requester_location_name' | 'target_location_name' | 'production_location_name'
  >,
  owner: ActionOwner,
): string {
  switch (owner) {
    case 'requester':
      return `${req.requester_location_name ?? "So‘rovchi"} qabuli kutilmoqda`;
    case 'production':
      return `${req.production_location_name ?? 'Отдел'} kutilmoqda`;
    case 'target':
      return `${req.target_location_name ?? 'Qabul'} kutilmoqda`;
    case 'none':
    default:
      return '';
  }
}

/**
 * True when a request is a `raw_warehouse`-targeted row that the raw manager has
 * ACCEPTED but the Поставка has not yet synced from Poster — it sits accepted
 * (`fulfiller_accepted_at`) yet still pre-ship (`pipelineStageOf === 'kutuvda'`,
 * so the engine has not auto-shipped on a stock landing). In that window the UI
 * shows a "Poster postavka kutilmoqda" state (phase F-G, raw Poster story).
 *
 * Takes the resolved `stage` so it stays dependency-free (the caller already
 * computed it for the column).
 */
export function isRawPosterWaiting(
  req: Pick<FlowRequest, 'target_location_type' | 'fulfiller_accepted_at'>,
  stage: PipelineStage,
): boolean {
  return (
    req.target_location_type === 'raw_warehouse' &&
    Boolean(req.fulfiller_accepted_at) &&
    stage === 'kutuvda'
  );
}

/** A two-part qty chip: a primary figure and an optional muted suffix. */
export interface QtyChip {
  /** The headline quantity, formatted (e.g. "4 000 gr (4 kg)"). */
  primary: string;
  /**
   * The muted "/ <needed>" comparison, formatted, or `null` when there is
   * nothing to compare (full ship, or not a ship column).
   */
  suffix: string | null;
}

/**
 * The qty chip for a request, shared by the card and the modal header (phase
 * F-L §3) so they read identically.
 *
 * On the Jo'natildi / Yopildi columns a row that actually SHIPPED a known amount
 * (`shipped_qty != null`) shows that SHIPPED figure as the primary, with a muted
 * `/ <qty_needed>` suffix ONLY when the two differ (a partial ship: "4 000 gr
 * (4 kg)" + "/ 10 kg"). A full ship (`shipped_qty === qty_needed`) shows just
 * the one figure. Every OTHER column — and any row with no `shipped_qty` (null /
 * absent on the wire, the pre-backend default) — falls back to plain
 * `qty_needed`, so nothing changes until the backend embeds the field.
 *
 * The suffix deliberately re-uses {@link formatQtyUnit} (full "gr (kg)" form) so
 * the unit reads the same on both halves; callers render `primary` in the chip
 * and `suffix` as muted text beside it.
 */
export function qtyChipFor(
  req: Pick<FlowRequest, 'qty_needed' | 'product_unit' | 'shipped_qty'>,
  column: KanbanColumn,
): QtyChip {
  const isShipColumn = column === 'yuborilgan' || column === 'yopilgan';
  const shipped = req.shipped_qty;
  if (isShipColumn && shipped != null && Number.isFinite(shipped)) {
    return {
      primary: formatQtyUnit(shipped, req.product_unit),
      suffix:
        shipped !== req.qty_needed
          ? `/ ${formatQtyUnit(req.qty_needed, req.product_unit)}`
          : null,
    };
  }
  return { primary: formatQtyUnit(req.qty_needed, req.product_unit), suffix: null };
}

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

// ---------------------------------------------------------------------------
// GET /api/purchase-orders/signals — PINNED, FROZEN shape (F-F, parallel build).
// Below-min raw-warehouse stock surfaced as actionable "Xarid signallari"
// cards so the homashyo boshlig'i can open a purchase-order draft straight
// from a starved row. Ordered most-starved first by the backend. RBAC:
// raw-warehouse keeper/manager + PM; a 404/403 (endpoint not yet live, or the
// caller lacks scope) MUST degrade gracefully — hide the section, no error.
// ---------------------------------------------------------------------------

/**
 * One below-min raw-material signal. `qty < min_level` always holds (the
 * backend only emits starved rows). `suggested_qty` is the pre-computed
 * top-up (typically `max_level - qty`) that prefills the create-PO form.
 *
 * `open_purchase_order_id` / `open_request_id` are mutually-informative: when
 * either is set there is already an in-flight document for this
 * `(product, location)` pair, so the card renders a link chip INSTEAD of the
 * "PO yaratish" button (no duplicate PO — mirrors Invariant 2 debounce).
 */
export interface PurchaseSignal {
  product_id: number;
  name: string;
  unit: string;
  location_id: number;
  location_name: string;
  qty: number;
  min_level: number;
  max_level: number;
  suggested_qty: number;
  /** An already-open purchase order for this pair, or `null`. */
  open_purchase_order_id: number | null;
  /** An already-open replenishment request for this pair, or `null`. */
  open_request_id: number | null;
}

/** `GET /api/purchase-orders/signals` envelope (PINNED). */
export interface PurchaseSignalsResponse {
  signals: PurchaseSignal[];
}

/**
 * Starvation tier of a signal — drives the colored ratio chip/bar:
 *   - `critical` — qty is 0–50% of min (qizil / danger).
 *   - `low`      — qty is 50–100% of min (sariq / warning).
 * A signal is always below min, so there is no "ok" tier here. Guards a zero
 * (or absent) `min_level` defensively: with no min there is no meaningful
 * ratio, so we treat it as the more urgent `critical` tier.
 */
export type StarvedTier = 'critical' | 'low';

/** Fraction of min that `qty` covers, clamped to [0, 1]. `0` when min ≤ 0. */
export function starvedRatio(signal: Pick<PurchaseSignal, 'qty' | 'min_level'>): number {
  if (signal.min_level <= 0) return 0;
  const ratio = signal.qty / signal.min_level;
  if (!Number.isFinite(ratio) || ratio < 0) return 0;
  return ratio > 1 ? 1 : ratio;
}

/** Classify a signal into its starvation tier from the qty/min ratio. */
export function starvedTier(
  signal: Pick<PurchaseSignal, 'qty' | 'min_level'>,
): StarvedTier {
  return starvedRatio(signal) <= 0.5 ? 'critical' : 'low';
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
