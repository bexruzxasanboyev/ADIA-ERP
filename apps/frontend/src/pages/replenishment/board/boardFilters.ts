import type { FlowRequest } from '@/lib/replenishmentFlow';

/**
 * Split a request list into the two boards every workspace shows
 * (cross-department-flow §1, §9.2):
 *
 *   - 📥 incoming ("Kelgan")  — I am the SUPPLIER: the request TARGETS one of my
 *                              locations (target_location_id ∈ scope), OR — for a
 *                              production workspace — the request is PRODUCTION-
 *                              ASSIGNED to one of my locations (see below).
 *   - 📤 outgoing ("Chiqgan") — I am the CUSTOMER: the request was RAISED by one
 *                              of my locations (requester_location_id ∈ scope).
 *
 * `scope` is the set of location ids the workspace owns — for a sex this is the
 * отдел id AND its sex_storage child (the producer-override pins a request's
 * target to the sex_storage, so both must be in scope for the krem→Qaymoq case
 * to land on the right board). A `null` scope = PM / chain-wide: every request
 * flows into BOTH boards (the PM reviews the whole chain read-only).
 *
 * PRODUCTION ASSIGNMENT (phase F-J). A production-bound request keeps its
 * `target_location_id` pointed at the central warehouse (central is still the
 * requester's supplier), yet the отдел that will MAKE it must see it on "Kelgan".
 * The PINNED backend field `production_location_id` (= the making order's
 * location, else the product's workshop) carries that link. When `production`
 * is passed, any row whose `production_location_id` ∈ `production` is ALSO
 * bucketed into incoming — deduped by id so a row that is both targeted and
 * production-assigned to the same workspace appears once. A null-safe fallback
 * matches `production_location_name` against `productionNames` (lower-cased) so
 * the row still surfaces in the window BEFORE the backend `production_location_id`
 * column lands (the name is already embedded today).
 *
 * The same row can legitimately appear on both boards when the workspace is
 * both the requester and the target (e.g. a sex topping up its own buffer) —
 * that mirrors the central pipeline's existing behaviour and is intentional:
 * §1 says "one request — visible from two sides".
 */
export interface BoardSplit {
  incoming: FlowRequest[];
  outgoing: FlowRequest[];
}

/**
 * Optional production-assignment matcher (phase F-J). Omitted by the central /
 * store workspaces; the production workspace passes its scope so
 * production-bound rows merge into "Kelgan".
 */
export interface ProductionAssignment {
  /** Location ids whose production-assigned rows count as incoming. */
  ids: ReadonlySet<number>;
  /**
   * Lower-cased отдел names, for the null-safe pre-backend fallback match on
   * `production_location_name`. Empty when not needed.
   */
  names: ReadonlySet<string>;
}

export function splitBoards(
  rows: readonly FlowRequest[],
  scope: ReadonlySet<number> | null,
  production?: ProductionAssignment,
): BoardSplit {
  const incoming: FlowRequest[] = [];
  const outgoing: FlowRequest[] = [];
  // Track ids already in `incoming` so a production-assigned row that is ALSO
  // targeted at the same scope is not pushed twice (board + column counts must
  // agree with the merge).
  const incomingIds = new Set<number>();
  const pushIncoming = (r: FlowRequest) => {
    if (incomingIds.has(r.id)) return;
    incomingIds.add(r.id);
    incoming.push(r);
  };

  const matchesProduction = (r: FlowRequest): boolean => {
    if (!production) return false;
    if (
      r.production_location_id != null &&
      production.ids.has(r.production_location_id)
    ) {
      return true;
    }
    // Null-safe fallback (before `production_location_id` lands): match the
    // embedded name. Only consulted when the id is absent so a renamed отдел
    // never silently drops a row the id already matched.
    if (
      r.production_location_id == null &&
      production.names.size > 0 &&
      r.production_location_name != null &&
      production.names.has(r.production_location_name.toLowerCase())
    ) {
      return true;
    }
    return false;
  };

  for (const r of rows) {
    if (scope === null) {
      // PM / chain-wide: every request is visible from both sides.
      pushIncoming(r);
      outgoing.push(r);
      continue;
    }
    if (r.target_location_id !== null && scope.has(r.target_location_id)) {
      pushIncoming(r);
    } else if (matchesProduction(r)) {
      // Production-assigned but not targeted at this scope → still "Kelgan".
      pushIncoming(r);
    }
    if (scope.has(r.requester_location_id)) {
      outgoing.push(r);
    }
  }
  return { incoming, outgoing };
}
