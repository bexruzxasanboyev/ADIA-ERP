/**
 * TZ Module 9 — Discrepancy log + report API ("Kassa tafovuti / fors-major").
 *
 *   GET   /api/discrepancies      — filterable, paginated log + summary card.
 *   PATCH /api/discrepancies/:id  — triage one row (acknowledge / resolve).
 *
 * The rows are persisted by `services/salesDiscrepancy.ts` from the two Poster
 * syncs (wrong-keyed over-sales + negative leftovers). This router is the
 * read/triage surface; detection and the Telegram digests are untouched.
 *
 * RBAC (mirrors the rest of the chain — invariant 6, "a store sees only its
 * own data"):
 *   - `pm` / `ai_assistant`        — chain-wide (every location).
 *   - any location-scoped manager  — scoped to `principal.locationIds`
 *     (M:N, ADR-0012). A scoped principal with no assigned location sees an
 *     empty log.
 *   PATCH additionally blocks `ai_assistant` (a read-only role) and requires a
 *   scoped manager to own the discrepancy's location.
 *
 * Every list is bounded (limit ≤ 200) and parameterized — no user input is
 * ever interpolated into SQL (security-and-hardening).
 */
import { Router } from 'express';
import { query, withTransaction, type SqlParam } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { writeAudit } from '../lib/audit.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import { asObject, optionalString, parseIdParam, requireEnum } from '../lib/validate.js';
import type { AuthPrincipal } from '../auth/jwt.js';

export const discrepanciesRouter: Router = Router();

/** The two anomaly kinds the log carries. */
const DISCREPANCY_KINDS = ['wrong_keyed', 'negative_stock'] as const;
type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number];

/** The triage lifecycle states. */
const DISCREPANCY_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
type DiscrepancyStatus = (typeof DISCREPANCY_STATUSES)[number];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_OFFSET = 0;

/** The list-item shape returned by both GET (per row) and PATCH (the updated row). */
type DiscrepancyItem = {
  id: number;
  kind: DiscrepancyKind;
  location_id: number;
  location_name: string | null;
  product_id: number;
  product_name: string | null;
  poster_transaction_id: string | null;
  sold_qty: number | null;
  had_qty: number | null;
  shortfall: number;
  detected_at: string;
  status: DiscrepancyStatus;
  resolved_by: number | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  note: string | null;
};

/** The columns + joins that build a `DiscrepancyItem`, shared by GET and PATCH. */
const ITEM_SELECT = `
  d.id,
  d.kind,
  d.location_id,
  l.name  AS location_name,
  d.product_id,
  p.name  AS product_name,
  d.poster_transaction_id,
  d.sold_qty,
  d.had_qty,
  d.shortfall,
  d.detected_at,
  d.status,
  d.resolved_by,
  ru.name AS resolved_by_name,
  d.resolved_at,
  d.note
  FROM sales_discrepancies d
  JOIN locations l ON l.id = d.location_id
  JOIN products  p ON p.id = d.product_id
  LEFT JOIN users ru ON ru.id = d.resolved_by`;

/** Raw pg row (numbers/dates arrive as strings/Date). */
type DiscrepancyRow = {
  id: string;
  kind: DiscrepancyKind;
  location_id: string;
  location_name: string | null;
  product_id: string;
  product_name: string | null;
  poster_transaction_id: string | null;
  sold_qty: string | null;
  had_qty: string | null;
  shortfall: string;
  detected_at: Date;
  status: DiscrepancyStatus;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: Date | null;
  note: string | null;
};

function mapRow(r: DiscrepancyRow): DiscrepancyItem {
  return {
    id: Number(r.id),
    kind: r.kind,
    location_id: Number(r.location_id),
    location_name: r.location_name,
    product_id: Number(r.product_id),
    product_name: r.product_name,
    poster_transaction_id: r.poster_transaction_id,
    sold_qty: r.sold_qty === null ? null : Number(r.sold_qty),
    had_qty: r.had_qty === null ? null : Number(r.had_qty),
    shortfall: Number(r.shortfall),
    detected_at: r.detected_at.toISOString(),
    status: r.status,
    resolved_by: r.resolved_by === null ? null : Number(r.resolved_by),
    resolved_by_name: r.resolved_by_name,
    resolved_at: r.resolved_at === null ? null : r.resolved_at.toISOString(),
    note: r.note,
  };
}

/**
 * Read scope. `pm`/`ai_assistant` see the whole chain; every other role is
 * narrowed to its assigned `locationIds`. An empty set (a scoped principal
 * with no location) yields an empty log.
 */
type ReadScope = { kind: 'chain' } | { kind: 'locations'; locationIds: number[] } | { kind: 'empty' };

function resolveReadScope(principal: AuthPrincipal): ReadScope {
  if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
    return { kind: 'chain' };
  }
  if (principal.locationIds.length === 0) {
    return { kind: 'empty' };
  }
  return { kind: 'locations', locationIds: principal.locationIds };
}

/** Parse a positive-integer-bounded query param with a default + cap. */
function parseBoundedInt(raw: unknown, dflt: number, min: number, max: number): number {
  if (typeof raw !== 'string' || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return dflt;
  return Math.min(n, max);
}

/** Parse an optional `?kind=` filter; throws 422 on an unknown value. */
function parseKindFilter(raw: unknown): DiscrepancyKind | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(DISCREPANCY_KINDS as readonly string[]).includes(raw)) {
    throw AppError.validation(`Query "kind" must be one of: ${DISCREPANCY_KINDS.join(', ')}.`);
  }
  return raw as DiscrepancyKind;
}

/** Parse an optional `?status=` filter; throws 422 on an unknown value. */
function parseStatusFilter(raw: unknown): DiscrepancyStatus | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(DISCREPANCY_STATUSES as readonly string[]).includes(raw)) {
    throw AppError.validation(`Query "status" must be one of: ${DISCREPANCY_STATUSES.join(', ')}.`);
  }
  return raw as DiscrepancyStatus;
}

/** Parse an optional `?location_id=` filter (positive int) or undefined. */
function parseLocationFilter(raw: unknown): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw AppError.validation('Query "location_id" must be a positive integer.');
  }
  return Number(raw);
}

/** Strict `YYYY-MM-DD` -> UTC instant; throws 422 otherwise. */
function parseDateBound(raw: unknown, label: string, endOfDay: boolean): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw AppError.validation(`Query "${label}" must be YYYY-MM-DD.`);
  }
  const base = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) {
    throw AppError.validation(`Query "${label}" is not a valid date.`);
  }
  // `to` is inclusive of the whole day → advance to the next midnight so the
  // SQL filter `< to` covers all of it.
  return endOfDay ? new Date(base.getTime() + 24 * 60 * 60 * 1000) : base;
}

// ---------------------------------------------------------------------------
// GET /api/discrepancies
// ---------------------------------------------------------------------------
// Filters: kind, status, location_id, from, to, limit, offset.
// Response: { items, total, summary:{ open, acknowledged, resolved,
//                                     wrong_keyed, negative_stock } }.
// `total` and `summary` respect the kind/location/date filters but SPAN every
// status (so the status counts always add up to the filtered population); the
// `items` list additionally applies the status filter + pagination.
discrepanciesRouter.get(
  '/',
  authenticate,
  authorize(
    'pm',
    'ai_assistant',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const scope = resolveReadScope(principal);

    const kind = parseKindFilter(req.query.kind);
    const status = parseStatusFilter(req.query.status);
    const locationFilter = parseLocationFilter(req.query.location_id);
    const from = parseDateBound(req.query.from, 'from', false);
    const to = parseDateBound(req.query.to, 'to', true);
    if (from !== undefined && to !== undefined && from >= to) {
      throw AppError.validation('Query "from" must be earlier than "to".');
    }
    const limit = parseBoundedInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = parseBoundedInt(req.query.offset, DEFAULT_OFFSET, 0, Number.MAX_SAFE_INTEGER);

    if (scope.kind === 'empty') {
      res.status(200).json({ items: [], total: 0, summary: emptySummary() });
      return;
    }

    // Build the shared WHERE (everything EXCEPT the status filter). The status
    // filter is applied only to the `items` list, so the summary status counts
    // span the full filtered population.
    const baseParams: SqlParam[] = [];
    const baseClauses: string[] = [];

    if (scope.kind === 'locations') {
      baseParams.push(scope.locationIds);
      baseClauses.push(`d.location_id = ANY($${baseParams.length}::bigint[])`);
    }
    if (locationFilter !== undefined) {
      baseParams.push(locationFilter);
      baseClauses.push(`d.location_id = $${baseParams.length}`);
    }
    if (kind !== undefined) {
      baseParams.push(kind);
      baseClauses.push(`d.kind = $${baseParams.length}`);
    }
    if (from !== undefined) {
      baseParams.push(from);
      baseClauses.push(`d.detected_at >= $${baseParams.length}`);
    }
    if (to !== undefined) {
      baseParams.push(to);
      baseClauses.push(`d.detected_at < $${baseParams.length}`);
    }
    const baseWhere = baseClauses.length > 0 ? `WHERE ${baseClauses.join(' AND ')}` : '';

    // Summary + total — one round-trip, spanning all statuses of the filtered set.
    const summaryQ = query<{
      total: string;
      open: string;
      acknowledged: string;
      resolved: string;
      wrong_keyed: string;
      negative_stock: string;
    }>(
      `SELECT
         count(*)                                              AS total,
         count(*) FILTER (WHERE d.status = 'open')             AS open,
         count(*) FILTER (WHERE d.status = 'acknowledged')     AS acknowledged,
         count(*) FILTER (WHERE d.status = 'resolved')         AS resolved,
         count(*) FILTER (WHERE d.kind = 'wrong_keyed')        AS wrong_keyed,
         count(*) FILTER (WHERE d.kind = 'negative_stock')     AS negative_stock
       FROM sales_discrepancies d
       ${baseWhere}`,
      baseParams,
    );

    // Items — adds the status filter + ORDER/LIMIT/OFFSET on top of the base set.
    const itemParams: SqlParam[] = [...baseParams];
    let itemWhere = baseWhere;
    if (status !== undefined) {
      itemParams.push(status);
      const clause = `d.status = $${itemParams.length}`;
      itemWhere = itemWhere === '' ? `WHERE ${clause}` : `${itemWhere} AND ${clause}`;
    }
    itemParams.push(limit);
    const limitIdx = itemParams.length;
    itemParams.push(offset);
    const offsetIdx = itemParams.length;

    const itemsQ = query<DiscrepancyRow>(
      `SELECT ${ITEM_SELECT}
       ${itemWhere}
       ORDER BY d.detected_at DESC, d.id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      itemParams,
    );

    const [summary, items] = await Promise.all([summaryQ, itemsQ]);
    const s = summary.rows[0];

    res.status(200).json({
      items: items.rows.map(mapRow),
      total: Number(s?.total ?? 0),
      summary: {
        open: Number(s?.open ?? 0),
        acknowledged: Number(s?.acknowledged ?? 0),
        resolved: Number(s?.resolved ?? 0),
        wrong_keyed: Number(s?.wrong_keyed ?? 0),
        negative_stock: Number(s?.negative_stock ?? 0),
      },
    });
  }),
);

function emptySummary(): {
  open: number;
  acknowledged: number;
  resolved: number;
  wrong_keyed: number;
  negative_stock: number;
} {
  return { open: 0, acknowledged: 0, resolved: 0, wrong_keyed: 0, negative_stock: 0 };
}

// ---------------------------------------------------------------------------
// PATCH /api/discrepancies/:id
// ---------------------------------------------------------------------------
// body: { status: 'open'|'acknowledged'|'resolved', note?: string }
// RBAC: pm OR the manager of the discrepancy's location (M:N). `ai_assistant`
// is read-only and is 403 here. On status='resolved' we stamp resolved_by +
// resolved_at; moving OFF 'resolved' clears them. Every change is audit-logged.
discrepanciesRouter.patch(
  '/:id(\\d+)',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const status = requireEnum<DiscrepancyStatus>(body, 'status', DISCREPANCY_STATUSES);
    const note = optionalString(body, 'note') ?? null;

    const updated = await withTransaction(async (tx) => {
      // Load the row (existence + its location for the ownership check).
      const { rows } = await tx.query<{ location_id: string; status: DiscrepancyStatus }>(
        `SELECT location_id, status FROM sales_discrepancies WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const existing = rows[0];
      if (existing === undefined) {
        throw AppError.notFound('Discrepancy not found.');
      }
      const locationId = Number(existing.location_id);

      // Ownership: pm passes for any location; a scoped manager must own it.
      // (404 already handled above — an unknown id is never an ownership leak.)
      if (!isSuperAdmin(principal) && !principal.locationIds.includes(locationId)) {
        throw AppError.forbidden('You may only triage discrepancies for your own location.');
      }

      // Resolve sets resolved_by/at; any non-resolved status clears them so a
      // re-opened row does not keep a stale resolver.
      const resolving = status === 'resolved';
      const { rows: updatedRows } = await tx.query<DiscrepancyRow>(
        `UPDATE sales_discrepancies AS d
            SET status      = $2,
                note        = COALESCE($3::text, d.note),
                resolved_by = CASE WHEN $4 THEN $5::bigint ELSE NULL END,
                resolved_at = CASE WHEN $4 THEN now() ELSE NULL END
          WHERE d.id = $1
          RETURNING ${RETURNING_SELECT}`,
        [id, status, note, resolving, principal.userId],
      );
      const row = updatedRows[0];
      if (row === undefined) {
        // Should be unreachable (we hold FOR UPDATE) — defensive.
        throw AppError.notFound('Discrepancy not found.');
      }

      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'sales_discrepancy.update',
        entity: 'sales_discrepancies',
        entityId: id,
        payload: {
          from_status: existing.status,
          to_status: status,
          note_set: note !== null,
          location_id: locationId,
        },
        activeLocationId: principal.activeLocationId,
      });

      return row;
    });

    // Re-shape via the same mapper used by GET (parity of the item shape). The
    // RETURNING above gives us the base columns; enrich the joined names with a
    // tiny follow-up so the response matches the list item exactly.
    const item = await enrichUpdatedItem(updated);
    res.status(200).json({ item });
  }),
);

/**
 * RETURNING list for the PATCH update — the raw `sales_discrepancies` columns
 * only (no joins; RETURNING cannot join). The joined names (location_name,
 * product_name, resolved_by_name) are filled by `enrichUpdatedItem`.
 */
const RETURNING_SELECT = `
  id, kind, location_id, NULL::text AS location_name,
  product_id, NULL::text AS product_name,
  poster_transaction_id, sold_qty, had_qty, shortfall,
  detected_at, status, resolved_by, NULL::text AS resolved_by_name,
  resolved_at, note`;

/**
 * Fill the three joined display names on the updated row with one read, so the
 * PATCH response item is byte-for-byte the same shape as a GET list item.
 */
async function enrichUpdatedItem(raw: DiscrepancyRow): Promise<DiscrepancyItem> {
  const { rows } = await query<{
    location_name: string | null;
    product_name: string | null;
    resolved_by_name: string | null;
  }>(
    `SELECT
       l.name  AS location_name,
       p.name  AS product_name,
       ru.name AS resolved_by_name
     FROM (SELECT $1::bigint AS location_id, $2::bigint AS product_id,
                  $3::bigint AS resolved_by) k
     LEFT JOIN locations l ON l.id = k.location_id
     LEFT JOIN products  p ON p.id = k.product_id
     LEFT JOIN users    ru ON ru.id = k.resolved_by`,
    [raw.location_id, raw.product_id, raw.resolved_by],
  );
  const names = rows[0];
  return mapRow({
    ...raw,
    location_name: names?.location_name ?? null,
    product_name: names?.product_name ?? null,
    resolved_by_name: names?.resolved_by_name ?? null,
  });
}
