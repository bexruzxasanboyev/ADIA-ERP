/**
 * Central-warehouse So'rovlar PIPELINE — bucketing logic.
 *
 * The owner's corrected single-flow model: the chain is ONE connected flow.
 * Each request lives in exactly ONE pipeline stage, shows ONE action, and
 * MOVES to the next stage when acted on — there is NO standalone "Sotib olish
 * so'rovi" at central. The markaziy sklad So'rovlar tab renders five stages:
 *
 *   Kutuvda · So'ralgan · Qabul qilingan · Yuborilgan · Tranzaksiyalar
 *
 * The backend is adding a `pipeline_stage` column (`'kutuvda' | 'soralgan' |
 * 'qabul_qilingan' | 'yuborilgan' | 'yopilgan'`) in parallel. This module is
 * the SINGLE source of truth that buckets a request:
 *   1. Prefer the backend's `pipeline_stage` verbatim when present.
 *   2. Otherwise fall back to a status + manual-flow-flag heuristic, mapping
 *      the existing 10-status state machine onto the five stages.
 *
 * Keeping every tab's filter behind {@link pipelineStageOf} guarantees a
 * request appears in exactly one tab and drops out of its old tab after an
 * action refetch (no stale lingering buttons — owner's complaint).
 */
import type { PipelineStage, ReplenishmentRequest } from './types';
import {
  kanbanColumnFromStage,
  type FlowRequest,
  type KanbanColumn,
} from './replenishmentFlow';

/**
 * Resolve the pipeline stage of a request.
 *
 * The stage depends only on the request's own status + flow flags (not on the
 * scope), so this takes just the request. Ownership scoping is applied
 * separately in {@link requestsInStage}.
 */
export function pipelineStageOf(req: ReplenishmentRequest): PipelineStage {
  // 1. Trust the backend's authoritative stage when it ships it.
  if (req.pipeline_stage != null) return req.pipeline_stage;

  // 2. Fallback heuristic over the 10-status state machine + flow flags.
  switch (req.status) {
    case 'CLOSED':
    case 'CANCELLED':
      return 'yopilgan';

    // Awaiting the manager's first touch — a store request to fulfil, OR a
    // production delivery handed to central and not yet confirmed-received.
    case 'NEW':
    case 'CHECK_STORE_SUPPLIER':
    case 'DONE_TO_WAREHOUSE':
      return 'kutuvda';

    // The shortfall is being produced (raw check / order creation / making).
    case 'CHECK_PRODUCTION_INPUT':
    case 'CREATE_PURCHASE_ORDER':
    case 'CREATE_PRODUCTION_ORDER':
    case 'PRODUCING':
      return 'soralgan';

    // SHIP_TO_REQUESTER straddles two stages: once central has CONFIRMED
    // receipt of the produced goods it is ready to forward (Qabul qilingan);
    // a request shipped to a store but not yet accepted there is Yuborilgan.
    // We distinguish on `received_from_production_at`: a manual/production
    // request that came back from the sex carries it; a plain central-stock
    // ship does not, so it is awaiting the store's acceptance.
    case 'SHIP_TO_REQUESTER':
      return req.received_from_production_at !== null
        ? 'qabul_qilingan'
        : 'yuborilgan';

    default:
      // Exhaustive over the current enum; any future status defaults to the
      // waiting bucket so it never silently vanishes from every tab.
      return 'kutuvda';
  }
}

/**
 * Resolve the Jira KANBAN column of a request (phase F-G — the 6-column board).
 *
 * Thin composition of {@link pipelineStageOf} (the authoritative 5-stage
 * bucket) + the client-only "Tasdiqlandi" split keyed on `fulfiller_accepted_at`
 * (see {@link kanbanColumnFromStage}). Kept here so the board never re-derives
 * the stage — one call covers both the legacy 5-stage surfaces (tree chips,
 * counts) and the new 6-column Kanban.
 */
export function kanbanColumnOf(req: FlowRequest): KanbanColumn {
  return kanbanColumnFromStage(pipelineStageOf(req), req);
}

/**
 * Filter a request list to one pipeline stage, relative to a central warehouse.
 * Newest-first. A scoped manager only sees requests touching their central
 * (it is the supplier/target, or it raised the request); PM sees all.
 */
export function requestsInStage(
  rows: readonly ReplenishmentRequest[],
  stage: PipelineStage,
  centralId: number | null,
): ReplenishmentRequest[] {
  const filtered = rows.filter((r) => {
    if (pipelineStageOf(r) !== stage) return false;
    if (centralId === null) return true;
    return (
      r.target_location_id === centralId ||
      r.requester_location_id === centralId
    );
  });
  return [...filtered].sort((a, b) => b.id - a.id);
}
