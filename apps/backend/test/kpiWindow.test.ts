/**
 * Unit tests for the GET /api/kpi/products reporting window — month default,
 * ?from/?to override, and the calendar-day salary pro-rating (no DB needed).
 */
import { describe, expect, it } from 'vitest';
import { resolveWindow, salaryProRateFactor } from '../src/routes/kpi.js';

describe('resolveWindow', () => {
  it('month mode is unchanged: whole month, salaryFactor 1', () => {
    const w = resolveWindow({ month: '2026-06' });
    expect(w.label).toBe('2026-06');
    expect(w.start).toBe('2026-06-01');
    expect(w.endExclusive).toBe('2026-07-01');
    expect(w.from).toBe('2026-06-01');
    expect(w.to).toBe('2026-06-30');
    expect(w.salaryFactor).toBe(1);
  });

  it('from/to override the month window (inclusive bounds)', () => {
    const w = resolveWindow({ month: '2026-06', from: '2026-06-05', to: '2026-06-10' });
    expect(w.start).toBe('2026-06-05');
    expect(w.endExclusive).toBe('2026-06-11'); // half-open upper bound = to + 1 day
    expect(w.from).toBe('2026-06-05');
    expect(w.to).toBe('2026-06-10');
    // 6 days of a 30-day month.
    expect(w.salaryFactor).toBeCloseTo(6 / 30, 10);
  });

  it('a cross-month range pro-rates each month separately', () => {
    const w = resolveWindow({ from: '2026-05-25', to: '2026-06-03' });
    // 7 days of May (31) + 3 days of June (30).
    expect(w.salaryFactor).toBeCloseTo(7 / 31 + 3 / 30, 10);
  });

  it('rejects a lone from/to, malformed dates, impossible days and from > to', () => {
    expect(() => resolveWindow({ from: '2026-06-01' })).toThrow();
    expect(() => resolveWindow({ from: '2026-06-01', to: 'abc' })).toThrow();
    expect(() => resolveWindow({ from: '2026-02-30', to: '2026-03-01' })).toThrow();
    expect(() => resolveWindow({ from: '2026-06-10', to: '2026-06-01' })).toThrow();
  });
});

describe('salaryProRateFactor', () => {
  it('a whole month is exactly 1', () => {
    const f = salaryProRateFactor(new Date(Date.UTC(2026, 5, 1)), new Date(Date.UTC(2026, 5, 30)));
    expect(f).toBeCloseTo(1, 10);
  });

  it('a single day carries 1/daysInMonth', () => {
    const f = salaryProRateFactor(new Date(Date.UTC(2026, 1, 10)), new Date(Date.UTC(2026, 1, 10)));
    expect(f).toBeCloseTo(1 / 28, 10);
  });

  it('a full year sums to 12 month-shares', () => {
    const f = salaryProRateFactor(new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 11, 31)));
    expect(f).toBeCloseTo(12, 10);
  });
});
