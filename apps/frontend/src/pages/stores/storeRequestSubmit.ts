import { apiRequest } from '@/lib/api-client';

/**
 * `POST /api/replenishment/batch` request body (per the team-lead contract).
 * Each item raises one replenishment_request for `(product, requester store)`;
 * the backend dedupes against invariant 2 (one open request per pair) and
 * reports back how many were created vs already-open.
 *
 * The requester location is the active store, taken from
 * `requester_location_id` in the body.
 */
export interface BatchRequestItem {
  product_id: number;
  qty_needed: number;
}

export interface BatchRequestBody {
  requester_location_id: number;
  items: BatchRequestItem[];
  note?: string;
}

/**
 * `POST /api/replenishment/batch` response (per contract). `results` reports a
 * per-product outcome. Optional on the wire so the summary degrades to a
 * generic success if the backend omits the counters.
 */
export interface BatchRequestResponse {
  results?: { product_id: number; status: 'created' | 'exists' | 'error' }[];
}

/** Submit a batch of store replenishment requests and return the response. */
export async function submitStoreRequestBatch(
  body: BatchRequestBody,
): Promise<BatchRequestResponse> {
  return apiRequest<BatchRequestResponse>('/api/replenishment/batch', {
    method: 'POST',
    body,
  });
}

/**
 * Build the user-facing success summary from a batch response, given the
 * number of items submitted. Mirrors the wording used in the create dialog.
 */
export function batchSuccessMessage(
  res: BatchRequestResponse,
  submittedCount: number,
): string {
  const rows = res.results ?? [];
  const created =
    rows.filter((r) => r.status === 'created').length || submittedCount;
  const exists = rows.filter((r) => r.status === 'exists').length;
  return exists > 0
    ? `${created} ta so‘rov yaratildi, ${exists} tasi allaqachon ochiq edi.`
    : `${created} ta so‘rov yaratildi.`;
}
