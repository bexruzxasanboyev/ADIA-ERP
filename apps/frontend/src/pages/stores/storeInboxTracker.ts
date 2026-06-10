import type { PipelineStage } from '@/lib/types';

/**
 * Everyday-language status strip for a store's OWN open request (research Rule
 * 6) — NO pipeline enum terms. The requester reads "where is my order" on their
 * card without ever opening a board.
 *
 *   Yuborildi → Tayyorlanmoqda → Yo'lda → Keldi
 */
export const STORE_TRACKER_STEPS = [
  'Yuborildi',
  'Tayyorlanmoqda',
  'Yo‘lda',
  'Keldi',
] as const;

/**
 * Map a request's pipeline stage to the 0-based active step of
 * {@link STORE_TRACKER_STEPS}:
 *
 *   kutuvda                       → 0 (Yuborildi — awaiting the warehouse)
 *   soralgan / qabul_qilingan     → 1 (Tayyorlanmoqda — being produced/prepared)
 *   yuborilgan                    → 2 (Yo'lda — shipped, not yet received here)
 *   yopilgan                      → 3 (Keldi — closed/received)
 *
 * Total over the 5-stage enum; an unknown value parks at step 0 so the strip
 * never renders blank.
 */
export function storeTrackerIndex(stage: PipelineStage): number {
  switch (stage) {
    case 'kutuvda':
      return 0;
    case 'soralgan':
    case 'qabul_qilingan':
      return 1;
    case 'yuborilgan':
      return 2;
    case 'yopilgan':
      return 3;
    default:
      return 0;
  }
}
