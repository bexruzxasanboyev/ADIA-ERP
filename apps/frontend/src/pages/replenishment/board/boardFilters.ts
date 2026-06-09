import type { FlowRequest } from '@/lib/replenishmentFlow';

/**
 * Split a request list into the two boards every workspace shows
 * (cross-department-flow §1, §9.2):
 *
 *   - 📥 incoming ("Kelgan")  — I am the SUPPLIER: the request TARGETS one of my
 *                              locations (target_location_id ∈ scope).
 *   - 📤 outgoing ("Chiqgan") — I am the CUSTOMER: the request was RAISED by one
 *                              of my locations (requester_location_id ∈ scope).
 *
 * `scope` is the set of location ids the workspace owns — for a sex this is the
 * отдел id AND its sex_storage child (the producer-override pins a request's
 * target to the sex_storage, so both must be in scope for the krem→Qaymoq case
 * to land on the right board). A `null` scope = PM / chain-wide: every request
 * flows into BOTH boards (the PM reviews the whole chain read-only).
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

export function splitBoards(
  rows: readonly FlowRequest[],
  scope: ReadonlySet<number> | null,
): BoardSplit {
  const incoming: FlowRequest[] = [];
  const outgoing: FlowRequest[] = [];
  for (const r of rows) {
    if (scope === null) {
      incoming.push(r);
      outgoing.push(r);
      continue;
    }
    if (r.target_location_id !== null && scope.has(r.target_location_id)) {
      incoming.push(r);
    }
    if (scope.has(r.requester_location_id)) {
      outgoing.push(r);
    }
  }
  return { incoming, outgoing };
}
