/**
 * Unit tests for the shared chart-bucket label helper.
 *
 * Covers the two granularities that the DateRangeFilter-scoped dashboard
 * charts use: day buckets (`DD.MM`, every range except "Bugun") and hour
 * buckets (`HH:00`, range=today), plus the backward-compatible data-driven
 * fallback when no explicit granularity is threaded.
 */
import { describe, expect, it } from 'vitest';
import { chartBucketLabel, hourLabel, shortDateLabel } from './chartTime';

describe('hourLabel', () => {
  it('zero-pads single-digit hours', () => {
    expect(hourLabel(0)).toBe('00:00');
    expect(hourLabel(8)).toBe('08:00');
  });

  it('renders two-digit hours unchanged', () => {
    expect(hourLabel(14)).toBe('14:00');
    expect(hourLabel(23)).toBe('23:00');
  });
});

describe('shortDateLabel', () => {
  it('formats an ISO date as DD.MM', () => {
    expect(shortDateLabel('2026-06-06')).toBe('06.06');
    expect(shortDateLabel('2026-12-31')).toBe('31.12');
  });

  it('returns the input unchanged when it is not an ISO date', () => {
    expect(shortDateLabel('not-a-date')).toBe('not-a-date');
  });
});

describe('chartBucketLabel', () => {
  it('renders HH:00 for an hourly bucket when granularity is hour', () => {
    expect(
      chartBucketLabel({ date: '2026-06-06', hour: 8 }, 'hour'),
    ).toBe('08:00');
    expect(
      chartBucketLabel({ date: '2026-06-06', hour: 14 }, 'hour'),
    ).toBe('14:00');
  });

  it('renders DD.MM for a day bucket when granularity is day', () => {
    expect(chartBucketLabel({ date: '2026-06-06' }, 'day')).toBe('06.06');
  });

  it('ignores a stray hour when granularity is explicitly day', () => {
    // A day series must never show an hour label even if a point happens to
    // carry an `hour` — the discriminator wins.
    expect(chartBucketLabel({ date: '2026-06-06', hour: 8 }, 'day')).toBe(
      '06.06',
    );
  });

  it('falls back to the data when granularity is omitted (hour present → HH:00)', () => {
    expect(chartBucketLabel({ date: '2026-06-06', hour: 8 })).toBe('08:00');
  });

  it('falls back to the data when granularity is omitted (no hour → DD.MM)', () => {
    expect(chartBucketLabel({ date: '2026-06-06' })).toBe('06.06');
  });
});
