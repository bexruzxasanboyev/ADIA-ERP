import {
  endOfDay,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import type { DateRangeValue } from '@/components/DateRangeFilter';

/**
 * Resolve a `DateRangeValue` preset into absolute `[from, to]` epoch-ms
 * bounds, applied client-side to filter rows by `created_at`. Shared by the
 * store workspace and the replenishment workspace so the two stay in lockstep
 * (owner feedback — extracted out of `StoreWorkflowPage`).
 */
export function rangeBounds(value: DateRangeValue): { from: number; to: number } {
  const now = new Date();
  const to = now.getTime();
  if (value.range === 'custom' && value.from && value.to) {
    return {
      from: startOfDay(parseISO(value.from)).getTime(),
      to: endOfDay(parseISO(value.to)).getTime(),
    };
  }
  switch (value.range) {
    case 'today':
      return { from: startOfDay(now).getTime(), to };
    case 'week':
      return { from: startOfWeek(now, { weekStartsOn: 1 }).getTime(), to };
    case 'month':
      return { from: startOfMonth(now).getTime(), to };
    case '6m':
      return { from: subMonths(now, 6).getTime(), to };
    default:
      return { from: 0, to };
  }
}
