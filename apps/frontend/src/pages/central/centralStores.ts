/**
 * Helpers for the central-warehouse "ship to store" basket (owner feedback
 * #15). The central_warehouse_manager is the fulfilment hub: it ships finished
 * goods to DOWNSTREAM stores. The "Do'konga yuborish" action posts a batch with
 * `requester_location_id = <store id>`.
 *
 * STORE-LIST SOURCE:
 * The destination picker is driven by the dedicated
 * `GET /api/replenishment/store-targets` endpoint, which returns EVERY store
 * (`type = 'store'`) the hub may ship to — not just the stores that have raised
 * a request. The central warehouse is the fulfilment hub, so it may push to any
 * downstream store (matching POST /batch, which accepts any
 * `requester_location_id`). Envelope: `{ stores: [{ id, name }] }`.
 */

/** One selectable downstream store for the ship-to-store picker. */
export interface CentralStoreOption {
  id: number;
  name: string;
}

/** `GET /api/replenishment/store-targets` envelope. */
export interface StoreTargetsResponse {
  stores: CentralStoreOption[];
}

/**
 * Normalise the `store-targets` payload into a de-duplicated, name-sorted list
 * of picker options. Names are kept as-is; a blank/missing name falls back to
 * `#<id>` so a row never renders nameless.
 */
export function storeOptionsFromTargets(
  rows: readonly CentralStoreOption[],
): CentralStoreOption[] {
  const byId = new Map<number, string>();
  for (const r of rows) {
    if (r.id == null) continue;
    const name = r.name?.trim();
    byId.set(r.id, name && name !== '' ? name : `#${r.id}`);
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
