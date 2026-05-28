import { useAuth } from './useAuth';
import type { Role } from '@/lib/types';

/**
 * Roles that the backend treats as read-and-recommend on every business
 * write endpoint (see `authorizeWrite()` — apps/backend/src/auth/rbac.ts).
 *
 * Mirrors the policy decision documented in `decisions.md` (RBAC §2.3):
 * the Project Manager (PM) and the AI assistant may inspect every chain
 * layer and propose changes, but only a location-scoped operator may
 * actually move stock, advance a request, or approve a purchase order.
 *
 * Keeping the list here in a single const lets every page importer share
 * the exact same definition — no string-literal drift between callers.
 */
const READ_ONLY_ROLES: ReadonlyArray<Role> = ['pm', 'ai_assistant'];

export interface UseCanActResult {
  /**
   * True when the signed-in user can ONLY read the chain — every write
   * button must be hidden. Mirrors backend `authorizeWrite()` which
   * returns 403 for these roles on every business endpoint.
   */
  isReadOnly: boolean;
  /**
   * True when the signed-in user is a location operator (any role that
   * the backend lets through `authorizeWrite()`). Convenient negation
   * of `isReadOnly` for callers that prefer the positive phrasing.
   */
  isOperator: boolean;
  /**
   * Decides whether the current user may act on a resource attached to
   * a given `location_id`. Mirrors the backend guard
   * `requireLocationOperator()` (apps/backend/src/auth/rbac.ts) so the
   * UI hides a button whenever the API would reject the call with 403.
   *
   * Rules (in order):
   *   1. No signed-in user                 → false.
   *   2. Read-only role (pm, ai_assistant) → false (PM never writes,
   *      even on a location it can see).
   *   3. `resourceLocationId` is nullish   → false. A write that lacks
   *      a target location is unsafe to render — the backend rejects
   *      it too. Callers that genuinely target multiple locations
   *      should call `canActOn` once per location and OR the results.
   *   4. The user is assigned to that location (M:N — ADR-0012)
   *      → true.
   *   5. Otherwise (foreign location)      → false.
   *
   * NOTE — the assignment check reads from `auth.locations`
   * (the M:N set hydrated by `/api/auth/me`). It does NOT fall back to
   * `user.location_id` because the primary is already inside
   * `locations` whenever it exists.
   */
  canActOn: (resourceLocationId: number | null | undefined) => boolean;
}

/**
 * Single source of truth for "may this user click this button?" on the
 * frontend. Pages should derive every write-action visibility from
 * `canActOn(resource.location_id)` instead of inline `role === 'pm'`
 * checks — otherwise the UI shows a button that the backend will 403
 * the moment the user clicks it (bad UX + audit-log noise).
 *
 * Example usage:
 * ```tsx
 * const { isReadOnly, canActOn } = useCanAct();
 * return (
 *   <>
 *     {isReadOnly && <Badge>Faqat o'qish</Badge>}
 *     {canActOn(order.location_id) && (
 *       <Button onClick={finish}>Yakunlash</Button>
 *     )}
 *   </>
 * );
 * ```
 */
export function useCanAct(): UseCanActResult {
  const { user, locations } = useAuth();

  const isReadOnly =
    user !== null && READ_ONLY_ROLES.includes(user.role);
  const isOperator = user !== null && !isReadOnly;

  const canActOn = (
    resourceLocationId: number | null | undefined,
  ): boolean => {
    if (user === null) return false;
    if (isReadOnly) return false;
    if (resourceLocationId === null || resourceLocationId === undefined) {
      return false;
    }
    return locations.some((loc) => loc.id === resourceLocationId);
  };

  return { isReadOnly, isOperator, canActOn };
}
