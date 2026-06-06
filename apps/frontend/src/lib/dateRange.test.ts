import { describe, it, expect } from 'vitest';
import {
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
  parseISO,
  endOfDay,
} from 'date-fns';
import { rangeBounds } from './dateRange';

describe('rangeBounds', () => {
  it('"today" starts at start-of-day and ends now', () => {
    const before = Date.now();
    const { from, to } = rangeBounds({ range: 'today' });
    const after = Date.now();
    expect(from).toBe(startOfDay(new Date(from)).getTime());
    expect(to).toBeGreaterThanOrEqual(before);
    expect(to).toBeLessThanOrEqual(after);
  });

  it('"week" starts on Monday (weekStartsOn: 1)', () => {
    const { from } = rangeBounds({ range: 'week' });
    expect(from).toBe(startOfWeek(new Date(), { weekStartsOn: 1 }).getTime());
  });

  it('"month" starts at the first of the current month', () => {
    const { from } = rangeBounds({ range: 'month' });
    expect(from).toBe(startOfMonth(new Date()).getTime());
  });

  it('"6m" starts six months ago', () => {
    const { from } = rangeBounds({ range: '6m' });
    // Tolerate the sub-ms drift between the two `new Date()` reads.
    expect(Math.abs(from - subMonths(new Date(), 6).getTime())).toBeLessThan(
      1000,
    );
  });

  it('"custom" uses inclusive start-of-day → end-of-day bounds', () => {
    const { from, to } = rangeBounds({
      range: 'custom',
      from: '2026-03-01',
      to: '2026-03-31',
    });
    expect(from).toBe(startOfDay(parseISO('2026-03-01')).getTime());
    expect(to).toBe(endOfDay(parseISO('2026-03-31')).getTime());
  });

  it('"custom" without from/to falls through to the open-ended default', () => {
    const { from } = rangeBounds({ range: 'custom' });
    expect(from).toBe(0);
  });
});
