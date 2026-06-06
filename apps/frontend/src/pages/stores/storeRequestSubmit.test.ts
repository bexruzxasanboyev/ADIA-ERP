import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the API client so the submit helper can be exercised without a network
// call — we assert it hits the SAME endpoint/payload the create dialog uses.
const apiRequest = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
}));

import {
  batchSuccessMessage,
  submitStoreRequestBatch,
  type BatchRequestResponse,
} from './storeRequestSubmit';

describe('submitStoreRequestBatch', () => {
  beforeEach(() => apiRequest.mockReset());

  it('POSTs the batch to /api/replenishment/batch with the store + items', async () => {
    apiRequest.mockResolvedValue({ results: [] });
    await submitStoreRequestBatch({
      requester_location_id: 7,
      items: [
        { product_id: 1, qty_needed: 3 },
        { product_id: 2, qty_needed: 5 },
      ],
    });
    expect(apiRequest).toHaveBeenCalledWith('/api/replenishment/batch', {
      method: 'POST',
      body: {
        requester_location_id: 7,
        items: [
          { product_id: 1, qty_needed: 3 },
          { product_id: 2, qty_needed: 5 },
        ],
      },
    });
  });
});

describe('batchSuccessMessage', () => {
  it('reports the created count when nothing was already open', () => {
    const res: BatchRequestResponse = {
      results: [
        { product_id: 1, status: 'created' },
        { product_id: 2, status: 'created' },
      ],
    };
    expect(batchSuccessMessage(res, 2)).toBe('2 ta so‘rov yaratildi.');
  });

  it('reports created + already-open counts', () => {
    const res: BatchRequestResponse = {
      results: [
        { product_id: 1, status: 'created' },
        { product_id: 2, status: 'exists' },
      ],
    };
    expect(batchSuccessMessage(res, 2)).toBe(
      '1 ta so‘rov yaratildi, 1 tasi allaqachon ochiq edi.',
    );
  });

  it('falls back to the submitted count when the backend omits results', () => {
    expect(batchSuccessMessage({}, 4)).toBe('4 ta so‘rov yaratildi.');
  });
});
