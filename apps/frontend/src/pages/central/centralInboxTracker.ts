import type { PipelineStage } from '@/lib/types';

/**
 * Everyday-language status strip for a central row already on its way to a store
 * (research Rule 6) — the «Kutilmoqda» section of the central «Ishlarim» feed.
 * NO pipeline enum terms.
 *
 *   Tayyorlandi → Jo'natildi → Do'kon oldi
 */
export const CENTRAL_TRACKER_STEPS = [
  'Tayyorlandi',
  'Jo‘natildi',
  'Do‘kon oldi',
] as const;

/**
 * Map a request's pipeline stage to the 0-based active step of
 * {@link CENTRAL_TRACKER_STEPS}:
 *
 *   qabul_qilingan → 0 (Tayyorlandi — received from production, ready to forward)
 *   yuborilgan     → 1 (Jo'natildi — shipped to the store, awaiting its receipt)
 *   yopilgan       → 2 (Do'kon oldi — closed/received by the store)
 *
 * The «Kutilmoqda» list only ever holds `yuborilgan` rows today, but the map is
 * total so the strip never renders blank for an adjacent stage.
 */
export function centralTrackerIndex(stage: PipelineStage): number {
  switch (stage) {
    case 'qabul_qilingan':
      return 0;
    case 'yuborilgan':
      return 1;
    case 'yopilgan':
      return 2;
    default:
      return 1;
  }
}
