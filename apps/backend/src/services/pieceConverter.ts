/**
 * TZ Module 11 — Inventarizatsiya konverteri (bo'lak ↔ butun).
 *
 * GROUNDED MODEL (data investigation, 2026-06-09): cakes are sold BY WEIGHT
 * (КГ), NOT as separate piece / whole SKUs. Every finished product is
 * `unit='kg'` and a sale is a decimal-kg qty. So a "whole" (butun) cake is
 * defined by its WEIGHT, and a "piece" (bo'lak) is a weight FRACTION of that
 * whole. The converter therefore needs TWO per-product coefficients, kept on
 * `products`:
 *
 *   - `weight_per_whole`  — kg of ONE complete whole cake (e.g. Napoleon = 1.0).
 *   - `pieces_per_whole`  — how many slices a whole is cut into (e.g. 8).
 *
 * A product with BOTH coefficients NULL is "not whole-and-sliced" — the
 * end-of-day converter skips it (see routes/inventory.ts). This file is a PURE
 * math module (no DB, no I/O) so it is trivially unit-tested and reused by the
 * inventory routes and the AI assistant alike.
 *
 * IMPORTANT — this is NOT `recipe_yield` (migration 0041 /
 * services/recipeYieldEstimate.ts). `recipe_yield` is a COST / BOM concept
 * ("how many finished units one recipe batch makes", used to divide the
 * per-unit material cost). The whole/piece coefficients here are an INVENTORY
 * COUNTING concept (how an operator tallies physical stock on the shelf). They
 * are deliberately separate columns and must not be conflated.
 */

/** The result of decomposing a kg quantity into whole cakes + slices + remnant. */
export interface WholePieces {
  /** Number of complete whole cakes (integer, >= 0). */
  readonly whole: number;
  /** Number of leftover slices below one whole (integer, 0 .. pieces_per_whole-1). */
  readonly pieces: number;
  /**
   * Any kg left over BELOW one slice (>= 0). For a clean cut this is ~0; it
   * exists because real stock (`12.137 kg`) need not be an exact multiple of a
   * slice weight. The reverse function adds it back so a round-trip is lossless.
   */
  readonly remnant_kg: number;
}

/**
 * Rounding precision for the leftover-kg remnant. The schema stores
 * `counted_remnant_kg NUMERIC(14,4)` and `qty NUMERIC(14,4)`, so we keep the
 * same 4-dp resolution here — anything finer is noise the DB would truncate.
 */
const REMNANT_DP = 4;

/**
 * Float-noise tolerance (kg). A residual within ±this of zero is treated as
 * exactly zero — it is below the gram and far below the `NUMERIC(14,4)`
 * storage resolution. Used so float dust from products like `2 * 1.6` does not
 * trip the overshoot step-down on an exact slice boundary.
 */
const FLOAT_DUST = 1e-9;

/** Round to a fixed number of decimal places (half-away-from-zero). */
function roundTo(value: number, dp: number): number {
  const factor = 10 ** dp;
  // `Number.EPSILON` nudge avoids the classic 1.005-rounds-down float artefact.
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Decompose a kg quantity into { whole, pieces, remnant_kg } for one product.
 *
 *   slice_weight = weight_per_whole / pieces_per_whole
 *   whole        = floor(qtyKg / weight_per_whole)
 *   tailKg       = qtyKg − whole * weight_per_whole          (the sub-whole tail)
 *   pieces       = round(tailKg / slice_weight)
 *   ROLLOVER     : if pieces == pieces_per_whole → whole += 1, pieces = 0
 *   remnant_kg   = qtyKg − whole * weight_per_whole − pieces * slice_weight
 *
 * The `round()` on the slice count is the friendly display the spec mandates
 * ("you have ~2 whole + 4 slices"). Two edges fall out of it and are handled so
 * the result is always sane AND `wholePiecesToKg` round-trips it:
 *
 *   - ROLLOVER (round UP a near-full tail to a whole): a tail of 7.6 of 8 slices
 *     rounds to 8 → that IS another whole, not "8 slices", so whole += 1 and
 *     pieces = 0.
 *   - OVERSHOOT (round UP a sub-slice tail): `round` can make
 *     `pieces * slice_weight` exceed the tail, which would make the remnant
 *     negative. We step the piece count DOWN by one (re-absorbing that slice
 *     into the remnant) so `remnant_kg` is the TRUE, non-negative physical
 *     leftover and the round-trip stays exact.
 *
 * Net contract: `pieces` is always in `[0, pieces_per_whole)`, `remnant_kg` is
 * always `>= 0`, and `wholePiecesToKg(whole, pieces, ..., remnant_kg)` returns
 * the original `qtyKg` exactly — EXCEPT the rollover-up corner (tail ≈ a full
 * whole), where the result is the nearest whole and the round-trip is lossy by
 * at most a sub-slice (< 1 g for a typical cake; below the NUMERIC(14,4)
 * resolution and below what an operator would ever count).
 *
 * @throws RangeError when either coefficient is not a finite number > 0.
 */
export function kgToWholePieces(
  qtyKg: number,
  weightPerWhole: number,
  piecesPerWhole: number,
): WholePieces {
  assertCoefficients(weightPerWhole, piecesPerWhole);
  if (!Number.isFinite(qtyKg) || qtyKg < 0) {
    throw new RangeError('kgToWholePieces: qtyKg must be a finite number >= 0.');
  }

  const sliceWeight = weightPerWhole / piecesPerWhole;

  let whole = Math.floor(qtyKg / weightPerWhole);
  let pieces = Math.round((qtyKg - whole * weightPerWhole) / sliceWeight);

  // ROLLOVER: rounding lifted the tail to a full whole.
  if (pieces >= piecesPerWhole) {
    whole += 1;
    pieces = 0;
  }

  // OVERSHOOT: round() pushed the slice count past the actual tail. Step down
  // one slice at a time until the remnant is non-negative (at most once in
  // practice). `pieces` cannot underflow below 0 here. The guard uses a small
  // negative tolerance so float dust (e.g. -2e-16 from `2*1.6`) on an EXACT
  // slice boundary does NOT spuriously drop a legitimate slice.
  let remnant = qtyKg - whole * weightPerWhole - pieces * sliceWeight;
  while (pieces > 0 && remnant < -FLOAT_DUST) {
    pieces -= 1;
    remnant += sliceWeight;
  }

  // Clamp residual float dust (and the rollover-up sub-slice loss) to 0.
  const remnant_kg = remnant <= FLOAT_DUST ? 0 : roundTo(remnant, REMNANT_DP);

  return { whole, pieces, remnant_kg };
}

/**
 * Recompose a { whole, pieces, remnant_kg } tally back into a kg quantity:
 *
 *   kg = whole * weight_per_whole
 *      + pieces * (weight_per_whole / pieces_per_whole)
 *      + remnantKg
 *
 * `remnantKg` is the operator-entered sub-slice leftover (defaults to 0). The
 * result is rounded to 4 dp to match the `NUMERIC(14,4)` storage and to keep
 * `kgToWholePieces → wholePiecesToKg` a lossless round-trip.
 *
 * @throws RangeError when either coefficient is not a finite number > 0, or a
 *         component is negative / non-finite.
 */
export function wholePiecesToKg(
  whole: number,
  pieces: number,
  weightPerWhole: number,
  piecesPerWhole: number,
  remnantKg = 0,
): number {
  assertCoefficients(weightPerWhole, piecesPerWhole);
  if (!Number.isFinite(whole) || whole < 0) {
    throw new RangeError('wholePiecesToKg: whole must be a finite number >= 0.');
  }
  if (!Number.isFinite(pieces) || pieces < 0) {
    throw new RangeError('wholePiecesToKg: pieces must be a finite number >= 0.');
  }
  if (!Number.isFinite(remnantKg) || remnantKg < 0) {
    throw new RangeError('wholePiecesToKg: remnantKg must be a finite number >= 0.');
  }

  const sliceWeight = weightPerWhole / piecesPerWhole;
  const kg = whole * weightPerWhole + pieces * sliceWeight + remnantKg;
  return roundTo(kg, REMNANT_DP);
}

/** Shared coefficient guard — both must be finite and strictly positive. */
function assertCoefficients(weightPerWhole: number, piecesPerWhole: number): void {
  if (!Number.isFinite(weightPerWhole) || weightPerWhole <= 0) {
    throw new RangeError('weight_per_whole must be a finite number > 0.');
  }
  if (!Number.isFinite(piecesPerWhole) || piecesPerWhole <= 0) {
    throw new RangeError('pieces_per_whole must be a finite number > 0.');
  }
}
