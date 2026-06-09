/**
 * TZ Module 11 — pure piece-converter math (services/pieceConverter.ts).
 *
 * Pure unit tests (no DB). Cover:
 *   - basic whole + slice decomposition;
 *   - the pieces == pieces_per_whole ROLLOVER edge (round() lifts a tail to a
 *     full whole);
 *   - exact wholes / exact slices / zero;
 *   - the sub-slice remnant (real stock need not be an exact slice multiple);
 *   - a kgToWholePieces → wholePiecesToKg round-trip is lossless;
 *   - coefficient + argument validation throws.
 */
import { describe, expect, it } from 'vitest';
import { kgToWholePieces, wholePiecesToKg } from '../src/services/pieceConverter.js';

describe('kgToWholePieces', () => {
  it('decomposes a 1 kg / 8-slice cake: 2.5 kg → 2 whole + 4 slices', () => {
    // weight_per_whole=1.0, pieces_per_whole=8 → slice = 0.125 kg.
    // 2.5 kg = 2 whole (2.0) + 0.5 kg tail = 0.5 / 0.125 = 4 slices, 0 remnant.
    const r = kgToWholePieces(2.5, 1.0, 8);
    expect(r).toEqual({ whole: 2, pieces: 4, remnant_kg: 0 });
  });

  it('handles a whole != 1 kg (1.6 kg cake, 8 slices): 4.0 kg → 2 whole + 4 slices', () => {
    // slice = 1.6 / 8 = 0.2 kg. 4.0 = 2 whole (3.2) + 0.8 tail = 4 slices, 0 remnant.
    const r = kgToWholePieces(4.0, 1.6, 8);
    expect(r).toEqual({ whole: 2, pieces: 4, remnant_kg: 0 });
  });

  it('ROLLOVER: a tail that rounds to a FULL whole rolls into whole, pieces=0', () => {
    // slice = 0.125. Take 0.96 kg tail on top of 1 whole = 1.96 kg.
    // 0.96 / 0.125 = 7.68 → round = 8 == pieces_per_whole → roll to +1 whole, 0 pieces.
    const r = kgToWholePieces(1.96, 1.0, 8);
    expect(r.whole).toBe(2);
    expect(r.pieces).toBe(0);
  });

  it('does NOT roll over just below the half-slice threshold', () => {
    // 7.4 slices rounds DOWN to 7 — stays 1 whole + 7 slices.
    // 1 whole (1.0) + 7.4 slices * 0.125 = 1.925 kg.
    const r = kgToWholePieces(1.925, 1.0, 8);
    expect(r.whole).toBe(1);
    expect(r.pieces).toBe(7);
  });

  it('exact wholes → no pieces, no remnant', () => {
    expect(kgToWholePieces(3.0, 1.0, 8)).toEqual({ whole: 3, pieces: 0, remnant_kg: 0 });
  });

  it('less than one whole → 0 whole + slices', () => {
    // 0.375 kg = 0 whole + 0.375 / 0.125 = 3 slices.
    expect(kgToWholePieces(0.375, 1.0, 8)).toEqual({ whole: 0, pieces: 3, remnant_kg: 0 });
  });

  it('zero stock → all zero', () => {
    expect(kgToWholePieces(0, 1.0, 8)).toEqual({ whole: 0, pieces: 0, remnant_kg: 0 });
  });

  it('captures a sub-slice remnant when stock is not an exact slice multiple', () => {
    // slice = 0.125. 1.30 kg = 1 whole (1.0) + 0.30 tail.
    // 0.30 / 0.125 = 2.4 → round = 2 slices (0.25 kg) + remnant 0.05 kg.
    const r = kgToWholePieces(1.3, 1.0, 8);
    expect(r.whole).toBe(1);
    expect(r.pieces).toBe(2);
    expect(r.remnant_kg).toBeCloseTo(0.05, 4);
  });

  it('keeps remnant NON-NEGATIVE when round() overshoots the slice count', () => {
    // slice = 0.2 (1.4 kg / 7). 0.7 kg tail = 3.5 slices → round-half-up = 4,
    // but 4 slices (0.8) overshoot 0.7 → step DOWN to 3 slices (0.6) + 0.1 remnant.
    const r = kgToWholePieces(0.7, 1.4, 7);
    expect(r.whole).toBe(0);
    expect(r.pieces).toBe(3);
    expect(r.remnant_kg).toBeCloseTo(0.1, 4);
  });
});

describe('wholePiecesToKg', () => {
  it('recomposes whole + slices back to kg', () => {
    // 2 whole + 4 slices, slice = 0.125 → 2.0 + 0.5 = 2.5 kg.
    expect(wholePiecesToKg(2, 4, 1.0, 8)).toBeCloseTo(2.5, 4);
  });

  it('adds the leftover remnant kg back', () => {
    // 1 whole + 2 slices (0.25) + 0.05 remnant = 1.30 kg.
    expect(wholePiecesToKg(1, 2, 1.0, 8, 0.05)).toBeCloseTo(1.3, 4);
  });

  it('round-trips EXACT-slice-multiple stock losslessly (whole + n slices, no remnant)', () => {
    // When stock lands exactly on a slice boundary there is no rounding, so the
    // round-trip is exact to full precision.
    //   1 kg / 8: slice 0.125 → 2.5, 0.375, 4.0, 7.625 are all slice multiples.
    for (const kg of [0, 0.375, 2.5, 4.0, 7.625]) {
      const wp = kgToWholePieces(kg, 1.0, 8);
      expect(wp.remnant_kg).toBe(0);
      const back = wholePiecesToKg(wp.whole, wp.pieces, 1.0, 8, wp.remnant_kg);
      expect(back).toBeCloseTo(kg, 4);
    }
  });

  it('round-trips ARBITRARY (messy) stock losslessly when the captured remnant is fed back', () => {
    // The remnant is the exact non-negative residual, so feeding the full
    // {whole, pieces, remnant_kg} tally back reproduces the original kg — EXCEPT
    // the rollover-up corner (tail rounds up across a whole boundary), which is
    // covered separately. These messy values avoid that corner.
    const cases: { kg: number; w: number; p: number }[] = [
      { kg: 1.3, w: 1.0, p: 8 },
      { kg: 12.137, w: 1.0, p: 8 },
      { kg: 0.7, w: 1.4, p: 7 },
      { kg: 2.35, w: 1.4, p: 7 },
      { kg: 5.0, w: 1.4, p: 7 },
    ];
    for (const { kg, w, p } of cases) {
      const wp = kgToWholePieces(kg, w, p);
      expect(wp.remnant_kg).toBeGreaterThanOrEqual(0);
      expect(wp.pieces).toBeLessThan(p);
      const back = wholePiecesToKg(wp.whole, wp.pieces, w, p, wp.remnant_kg);
      expect(back).toBeCloseTo(kg, 4);
    }
  });

  it('the rollover-up corner (tail ≈ a full whole) snaps to the nearest whole', () => {
    // 99.9999 kg of a 1 kg / 8-slice cake: the 0.9999 tail is 7.9992 slices,
    // which rounds to 8 = a full whole. The decomposition is 100 whole, 0
    // slices, 0 remnant — the nearest-whole answer; the round-trip is lossy by
    // the sub-gram tail (< the half-slice rounding granularity), by design.
    const wp = kgToWholePieces(99.9999, 1.0, 8);
    expect(wp).toEqual({ whole: 100, pieces: 0, remnant_kg: 0 });
    const back = wholePiecesToKg(wp.whole, wp.pieces, 1.0, 8, wp.remnant_kg);
    // Within half a slice (0.0625 kg) of the original — the rounding resolution.
    expect(Math.abs(back - 99.9999)).toBeLessThan(1.0 / 8 / 2);
  });

  it('GENERAL property: any messy stock round-trips to within half a slice', () => {
    // The universal guarantee across the whole domain (incl. rollover corners):
    // a round-trip is never off by more than the rounding granularity.
    const w = 1.0;
    const p = 8;
    const halfSlice = w / p / 2;
    for (let i = 0; i < 200; i += 1) {
      const kg = Math.round(Math.random() * 50_0000) / 10_000; // 0..50 kg, 4 dp
      const wp = kgToWholePieces(kg, w, p);
      expect(wp.whole).toBeGreaterThanOrEqual(0);
      expect(wp.pieces).toBeGreaterThanOrEqual(0);
      expect(wp.pieces).toBeLessThan(p);
      expect(wp.remnant_kg).toBeGreaterThanOrEqual(0);
      const back = wholePiecesToKg(wp.whole, wp.pieces, w, p, wp.remnant_kg);
      expect(Math.abs(back - kg)).toBeLessThanOrEqual(halfSlice + 1e-9);
    }
  });
});

describe('validation', () => {
  it('kgToWholePieces throws on non-positive coefficients', () => {
    expect(() => kgToWholePieces(1, 0, 8)).toThrow(RangeError);
    expect(() => kgToWholePieces(1, 1.0, 0)).toThrow(RangeError);
    expect(() => kgToWholePieces(1, -1, 8)).toThrow(RangeError);
  });

  it('kgToWholePieces throws on a negative qty', () => {
    expect(() => kgToWholePieces(-1, 1.0, 8)).toThrow(RangeError);
  });

  it('wholePiecesToKg throws on non-positive coefficients and negative parts', () => {
    expect(() => wholePiecesToKg(1, 0, 0, 8)).toThrow(RangeError);
    expect(() => wholePiecesToKg(-1, 0, 1.0, 8)).toThrow(RangeError);
    expect(() => wholePiecesToKg(1, -1, 1.0, 8)).toThrow(RangeError);
    expect(() => wholePiecesToKg(1, 0, 1.0, 8, -0.1)).toThrow(RangeError);
  });
});
