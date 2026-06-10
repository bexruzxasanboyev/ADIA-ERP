/**
 * Pure unit tests for `parsePosterNumber` — the locale-tolerant numeric parser
 * for Poster API strings (no DB needed).
 *
 * Live-verified formats (`adia`, 2026-06-08 / 2026-06-10):
 *   - num "3,000.0000000" (TX 794490)  — comma thousands + dot decimal -> 3000
 *   - payed_sum "1,440,000" (TX 794423) — multi-comma thousands -> 1440000
 *   - num "770.0000000" / "2"           — plain values pass through
 * Defensive comma-decimal forms ("0,770", "12,5") and space grouping ("1 000")
 * are also covered — a single comma with no dot is a DECIMAL separator.
 */
import { describe, expect, it } from 'vitest';
import { parsePosterNumber } from '../src/integrations/poster/salesSync.js';

describe('parsePosterNumber', () => {
  it('treats a single comma with no dot as a decimal separator ("0,770" -> 0.77)', () => {
    expect(parsePosterNumber('0,770')).toBeCloseTo(0.77, 6);
  });

  it('parses a plain integer ("2" -> 2)', () => {
    expect(parsePosterNumber('2')).toBe(2);
  });

  it('parses a comma-decimal fraction ("12,5" -> 12.5)', () => {
    expect(parsePosterNumber('12,5')).toBeCloseTo(12.5, 6);
  });

  it('strips space thousands grouping ("1 000" -> 1000)', () => {
    expect(parsePosterNumber('1 000')).toBe(1000);
  });

  it('treats a comma as thousands grouping when a dot decimal is present (live TX 794490)', () => {
    expect(parsePosterNumber('3,000.0000000')).toBe(3000);
    expect(parsePosterNumber('1,440.0000000')).toBe(1440);
  });

  it('treats multiple commas as thousands grouping (live payed_sum "1,440,000")', () => {
    expect(parsePosterNumber('1,440,000')).toBe(1_440_000);
  });

  it('passes plain decimal strings and numbers through', () => {
    expect(parsePosterNumber('770.0000000')).toBe(770);
    expect(parsePosterNumber(3.5)).toBe(3.5);
  });

  it('returns NaN for missing or non-numeric input', () => {
    expect(Number.isNaN(parsePosterNumber(undefined))).toBe(true);
    expect(Number.isNaN(parsePosterNumber(null))).toBe(true);
    expect(Number.isNaN(parsePosterNumber('abc'))).toBe(true);
  });
});
