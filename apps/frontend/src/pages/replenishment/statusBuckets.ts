import type { ReplenishmentRequest } from '@/lib/types';
import { pipelineStageOf } from '@/lib/pipeline';

/**
 * The status sub-tab buckets of the replenishment workspace — now bucketed on
 * the canonical 5-stage `pipeline_stage` grammar (cross-department-flow §9.1),
 * replacing the retired 4-bucket (all/pending/sent/closed) scheme.
 *
 * One unified Kanban grammar across every workspace: a request lives in exactly
 * ONE stage column and moves to the next as it is acted on. The six buckets:
 *
 *   - `all`            — every row (incl. closed/cancelled history);
 *   - `kutuvda`        — Kutuvda (awaiting the next step);
 *   - `soralgan`       — Tayyorlanmoqda (being produced / in flight);
 *   - `qabul_qilingan` — Tayyor (received, ready to forward);
 *   - `yuborilgan`     — Jo'natildi / rezerv (shipped, awaiting acceptance);
 *   - `yopilgan`       — Yopildi (closed / cancelled — with closure_reason badge).
 *
 * `statusInBucket` now takes the whole REQUEST (not just the status) because
 * the authoritative stage is the backend's `pipeline_stage` field — resolved
 * via {@link pipelineStageOf}, which prefers it and falls back to a status
 * heuristic only when it is absent. The exported name is kept so the call site
 * in `ReplenishmentPage` changes minimally.
 */
export type ReplenishmentBucket =
  | 'all'
  | 'kutuvda'
  | 'soralgan'
  | 'qabul_qilingan'
  | 'yuborilgan'
  | 'yopilgan';

/**
 * True when `request` belongs to `bucket`. Pure — drives both the active-tab
 * filter and the per-tab counts. `all` matches everything; the five stage
 * buckets are mutually exclusive (every request resolves to exactly one stage).
 */
export function statusInBucket(
  request: ReplenishmentRequest,
  bucket: ReplenishmentBucket,
): boolean {
  if (bucket === 'all') return true;
  return pipelineStageOf(request) === bucket;
}

/**
 * Tab order + Uzbek labels for the status sub-tab strip — the canonical 5
 * columns (§9.1) plus a leading "Hammasi". Labels match the owner's wording:
 * Kutuvda · Tayyorlanmoqda · Tayyor · Jo'natildi (rezerv) · Yopildi.
 */
export const REPLENISHMENT_BUCKETS: readonly {
  value: ReplenishmentBucket;
  label: string;
}[] = [
  { value: 'all', label: 'Hammasi' },
  { value: 'kutuvda', label: 'Kutuvda' },
  { value: 'soralgan', label: 'Tayyorlanmoqda' },
  { value: 'qabul_qilingan', label: 'Tayyor' },
  { value: 'yuborilgan', label: "Jo‘natildi" },
  { value: 'yopilgan', label: 'Yopildi' },
];
