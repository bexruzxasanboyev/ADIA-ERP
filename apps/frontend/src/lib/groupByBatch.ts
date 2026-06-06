/**
 * Group replenishment lines that were confirmed together into one order.
 *
 * A store basket sent in a single `POST /api/replenishment/batch` call shares
 * one `batch_id`, so the central inbox and the store's own sent list can render
 * the lines as ONE order card (header + N product lines) instead of N scattered
 * rows. Rows with `batch_id === null` (legacy / individually-raised) are NOT
 * grouped — each becomes its own single-line "order".
 *
 * Grouping key is `(requester_location_id, batch_id)`: two different stores can
 * never share a batch, and the requester is part of the identity so the central
 * inbox header can show the store name per group.
 */

/**
 * Minimal shape a row must satisfy to be groupable. `batch_id` is optional so
 * payloads that predate the column (where the field is absent) are accepted —
 * a missing/`undefined` value is treated exactly like `null` (ungrouped).
 */
export interface BatchGroupableRow {
  id: number;
  requester_location_id: number;
  batch_id?: number | null;
  created_at: string;
}

/** One grouped order: a batch of lines, or a single legacy row on its own. */
export interface BatchGroup<T extends BatchGroupableRow> {
  /** Stable React key: `b<batch_id>` for batches, `s<id>` for singles. */
  key: string;
  /** The batch id, or `null` for an ungrouped/legacy single row. */
  batch_id: number | null;
  /** The requester store/location id shared by every line in the group. */
  requester_location_id: number;
  /** Earliest `created_at` across the group's lines (the order time). */
  created_at: string;
  /** The lines in this order, in their original (incoming) order. */
  lines: T[];
}

/**
 * Group rows by `(requester_location_id, batch_id)`. `batch_id === null` rows
 * are emitted as singletons (one group per row). Groups are returned sorted by
 * `created_at` descending (newest order first); lines inside a group keep their
 * input order.
 */
export function groupByBatch<T extends BatchGroupableRow>(
  rows: readonly T[],
): BatchGroup<T>[] {
  const batches = new Map<string, BatchGroup<T>>();
  const singles: BatchGroup<T>[] = [];

  for (const row of rows) {
    const batchId = row.batch_id ?? null;
    if (batchId === null) {
      singles.push({
        key: `s${row.id}`,
        batch_id: null,
        requester_location_id: row.requester_location_id,
        created_at: row.created_at,
        lines: [row],
      });
      continue;
    }
    const mapKey = `${row.requester_location_id}:${batchId}`;
    const existing = batches.get(mapKey);
    if (existing) {
      existing.lines.push(row);
      if (row.created_at < existing.created_at) {
        existing.created_at = row.created_at;
      }
    } else {
      batches.set(mapKey, {
        key: `b${batchId}`,
        batch_id: batchId,
        requester_location_id: row.requester_location_id,
        created_at: row.created_at,
        lines: [row],
      });
    }
  }

  return [...batches.values(), ...singles].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}
