# Spec — Corrected central-warehouse request model (backend)

Owner-corrected 2026-06-08. Implements the connected single-flow chain
(Poster → raw → production ⇄ sex_storage → central → store) with a 5-status
pipeline view, partial fulfillment, reserved "yuborilgan" state, store-accept
finalization with a Poster central decrement (gated, dry-run by default), and a
server-side brak cap on every receive path.

NOTE: `salesSync.ts` and `seedSync.ts` are OWNED by the owner in parallel and
MUST NOT be touched. Poster write-back code lives in `services/posterWriteback.ts`.

## 1. `pipeline_stage` (computed, on GET list + GET single)

Every replenishment request API row carries a derived `pipeline_stage` ∈
`{ kutuvda | soralgan | qabul_qilingan | yuborilgan | yopilgan }`. The frontend
buckets on this field deterministically (it is total — every row maps to exactly
one stage). Derivation (evaluated top-down; first match wins):

1. **yopilgan** — `status = 'CANCELLED'`, OR (`status = 'CLOSED'` AND
   `closure_reason IS NOT NULL`). Terminal / accepted / rejected / returned /
   cancelled — the store has acted (or the request was cancelled).
2. **yuborilgan** — `status = 'CLOSED'` AND `closure_reason IS NULL`. Shipped to
   the store, reserved/in-transit, the store has NOT accepted yet.
3. **qabul_qilingan** — `status = 'SHIP_TO_REQUESTER'`. Received from production
   at central, ready to forward (covers both the manual route, where
   `received_from_production_at` is set, and a bare ready-to-ship internal row).
4. **kutuvda** — `status IN ('NEW','CHECK_STORE_SUPPLIER')` (store request not
   yet handled), OR (`status = 'DONE_TO_WAREHOUSE'` AND
   `route_to_production_manual`) (production delivery awaiting the central
   manager's receipt).
5. **soralgan** — everything else not yet terminal: the in-production / sourcing
   states `CHECK_PRODUCTION_INPUT | CREATE_PRODUCTION_ORDER | CREATE_PURCHASE_ORDER
   | PRODUCING`, and any non-manual `DONE_TO_WAREHOUSE` (internal auto-flow goods
   in the warehouse pending the auto-ship hop). Shortfall is being produced.

The order matters: rule 3 fires before rule 5 so a `SHIP_TO_REQUESTER` row is
`qabul_qilingan` (ready to forward), and rule 1 fires before rule 2 so an
accepted CLOSED row is `yopilgan` not `yuborilgan`.

A single SQL `CASE` expression on the list/single query computes it server-side
(no N+1); a mirrored TS pure function `derivePipelineStage(row)` is the single
source of truth used by tests.

## 2. `POST /api/replenishment/:id/fulfill` — partial fulfillment

RBAC: `central_warehouse_manager`, own central only (`requireLocationOperator`
on the acting central). PM 403. Body: `{ ship_qty?: number, note?: string }`.

For a STORE request bound for the acting central, in ONE transaction:
- pin `target_location_id = central` when null; reject (403) if it targets a
  different warehouse;
- `available = central on-hand(product)`; `ship_qty` defaults to
  `min(qty_needed, available)`, and a provided `ship_qty` is capped at
  `min(available, qty_needed)` and must be ≥ 0;
- **(a) ship the available portion**: if `ship_qty > 0`, transfer exactly
  `ship_qty` central→store (atomic `applyMovement`), set
  `shipment_movement_id`, flip the request to `CLOSED` (pipeline `yuborilgan` —
  store hasn't accepted yet). closure_reason stays NULL.
- **(b) shortfall to production**: `shortfall = qty_needed − ship_qty`. If
  `shortfall > 0`:
  - when `ship_qty > 0` (a real partial): CREATE a new grouped production
    request (requester = same store, qty = shortfall, same `batch_id` as the
    original) and route it to production via the shared sendToProduction path
    (pipeline `soralgan`). Its id is returned as `production_request_id`.
    Allowed because the original is now CLOSED (terminal), so the partial unique
    index `(product, requester) WHERE status NOT IN (CLOSED,CANCELLED)` permits a
    new open row.
  - when `ship_qty = 0` (nothing on hand): route the ORIGINAL request to
    production in place (no second row needed); `production_request_id = id`.

Response `200`: `{ shipped_qty, shortfall_qty, production_request_id?, request }`
(`request` = the original request row after the ship, enriched with
`pipeline_stage`).

`accept-central` stays for backward-compat (all-or-nothing); `fulfill` is the
new partial path used by the modal.

## 3. yuborilgan → store accepts → finalize + Poster central decrement

A CLOSED request with `closure_reason IS NULL` is `yuborilgan` (reserved). The
existing store-side accept flow (`POST /:id/receive` → `receiveShipment`, or
`POST /:id/accept` → `acceptShipment`) sets `closure_reason`, which moves it to
`yopilgan`. No new accept endpoint is needed.

On that accept, the goods physically leave the central, so the CENTRAL's Poster
storage must be decremented to match. New best-effort, idempotent function
`enqueueCentralDecrementWriteback({ requestId, productId, centralLocationId, qty })`
in `posterWriteback.ts`:
- resolves the central's `locations.poster_storage_id` (the singleton central is
  Poster storage 8) + the product's `poster_ingredient_id` + `ingredients_type`;
- builds the intended `storage.createWriteOff` payload
  (`storage_id`, `type`, `date`, `ingredients[0][id|type|weight]`);
- **SAFETY**: gated by env flag `POSTER_WRITE_ENABLED` (default **false →
  DRY-RUN**): logs the intended call + payload, does NOT call live Poster, marks
  the queue row `pending`. Only when `POSTER_WRITE_ENABLED=true` AND a write
  token is configured does it attempt the live call.
- idempotent via a unique `(request_id, product_id, direction='central_out')`
  key so a double-accept cannot double-decrement;
- runs AFTER the accept transaction commits, wrapped in try/catch — a Poster
  failure never rolls back the local accept.

Called from the `/receive` and `/accept` handlers (best-effort) using the
GOOD accepted qty (received_qty / qty_accepted), only when the request was a
store request shipped from a central (target is a central_warehouse).

We DO NOT execute any real write to the live `adia` Poster account during
testing — only the dry-run path + unit logic are verified.

## 4. Brak server-side cap

Already enforced; locked in by focused tests. On every receive path the
defective qty may not exceed the received/requested qty (→ 422
`VALIDATION_ERROR`):
- store receive (`receiveShipment`, 0045): `received_qty + brak_qty ≤ shipped`.
- receive-from-production (`receiveFromProduction`, 0055): `brak_qty ≤ qty_needed`.
- purchase-order receive (`purchaseOrder.receive`, 0056): `brak_qty ≤ ordered_qty`.

## 5. Migration

`0058_poster_writeback_direction.sql` — add a `direction` column to
`poster_writeback_queue` (`'store_in'` default for the existing store-receive
rows, `'central_out'` for the new central decrement) and replace the unique
index with `(request_id, product_id, direction)` so the two opposite write-backs
for one request coexist. Idempotent / additive.

## Invariants preserved
1 (atomic movement+audit), 2 (one open request per (product,location); ship+close
the original BEFORE creating the shortfall row), 3 (no negative stock — guarded
`applyMovement`), 4/6 (RBAC: own-central guard, PM 403), audit on every change.
