import { describe, expect, it } from 'vitest';
import { groupByBatch, type BatchGroupableRow } from './groupByBatch';

function row(
  id: number,
  batch_id: number | null,
  requester_location_id: number,
  created_at: string,
): BatchGroupableRow {
  return { id, batch_id, requester_location_id, created_at };
}

describe('groupByBatch', () => {
  it('groups rows sharing a batch_id into one order', () => {
    const groups = groupByBatch([
      row(1, 10, 5, '2026-06-06T10:00:00Z'),
      row(2, 10, 5, '2026-06-06T10:00:01Z'),
      row(3, 10, 5, '2026-06-06T10:00:02Z'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.batch_id).toBe(10);
    expect(groups[0]?.lines.map((l) => l.id)).toEqual([1, 2, 3]);
    // Earliest created_at is the order time.
    expect(groups[0]?.created_at).toBe('2026-06-06T10:00:00Z');
    expect(groups[0]?.key).toBe('b10');
  });

  it('renders null-batch rows as individual singletons', () => {
    const groups = groupByBatch([
      row(1, null, 5, '2026-06-06T10:00:00Z'),
      row(2, null, 5, '2026-06-06T10:00:01Z'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.lines.length === 1)).toBe(true);
    expect(groups.map((g) => g.key).sort()).toEqual(['s1', 's2']);
  });

  it('does not merge the same batch_id across different requesters', () => {
    const groups = groupByBatch([
      row(1, 10, 5, '2026-06-06T10:00:00Z'),
      row(2, 10, 6, '2026-06-06T10:00:01Z'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('sorts orders newest-first by created_at', () => {
    const groups = groupByBatch([
      row(1, 10, 5, '2026-06-06T09:00:00Z'),
      row(2, 11, 5, '2026-06-06T11:00:00Z'),
      row(3, null, 5, '2026-06-06T10:00:00Z'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['b11', 's3', 'b10']);
  });

  it('returns an empty array for no rows', () => {
    expect(groupByBatch([])).toEqual([]);
  });
});
