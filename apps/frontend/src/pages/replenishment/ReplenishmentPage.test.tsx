/**
 * Targeted tests for the redesigned replenishment workspace (owner feedback).
 *
 * jsdom + Radix portals are flaky for full dialog flows, so these tests focus
 * on the page's own logic and gating: the page tabs render, the status
 * sub-tabs filter + count correctly, "Mening so'rovlarim" narrows to the
 * signed-in user, and "So'rov qo'shish" is gated by role + active location.
 * The pure status→bucket mapping is unit-tested separately in
 * `statusBuckets.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import { __clearApiQueryCache } from '@/hooks/useApiQuery';
import { ReplenishmentPage } from './ReplenishmentPage';
import type { ReplenishmentRequest, ReplenishmentStatus } from '@/lib/types';

function makeRow(
  id: number,
  status: ReplenishmentStatus,
  overrides: Partial<ReplenishmentRequest> = {},
): ReplenishmentRequest {
  return {
    id,
    product_id: id,
    requester_location_id: 21,
    target_location_id: null,
    qty_needed: 10,
    status,
    production_order_id: null,
    purchase_order_id: null,
    shipment_movement_id: null,
    note: null,
    created_by: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
    product_name: `Mahsulot ${id}`,
    product_unit: 'kg',
    requester_location_name: 'Markaziy sklad',
    target_location_name: null,
    production_location_name: null,
    ...overrides,
  };
}

const ROWS: ReplenishmentRequest[] = [
  makeRow(1, 'NEW', { created_by: 1 }),
  makeRow(2, 'PRODUCING', { created_by: 7 }),
  makeRow(3, 'SHIP_TO_REQUESTER', { created_by: 1 }),
  makeRow(4, 'CLOSED', { created_by: 7 }),
  makeRow(5, 'CANCELLED', { created_by: 1 }),
];

function mockList(rows: ReplenishmentRequest[] = ROWS) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/replenishment')) {
      return Promise.resolve(jsonResponse(200, rows));
    }
    if (url.includes('/api/stock/movements')) {
      return Promise.resolve(
        jsonResponse(200, { items: [], total: 0, limit: 100, offset: 0 }),
      );
    }
    if (url.includes('/api/products')) {
      return Promise.resolve(jsonResponse(200, []));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('ReplenishmentPage — redesign', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __clearApiQueryCache();
  });

  it('renders the two page tabs (So‘rovlar / Tranzaksiyalar)', async () => {
    mockList();
    renderWithProviders(<ReplenishmentPage />, { role: 'pm' });
    await screen.findByText('#1');
    expect(screen.getByRole('tab', { name: 'So‘rovlar' })).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'Tranzaksiyalar' }),
    ).toBeInTheDocument();
  });

  it('labels the status sub-tabs with counts reflecting the data', async () => {
    mockList();
    renderWithProviders(<ReplenishmentPage />, { role: 'pm' });
    await screen.findByText('#1');
    // 5 rows total; pending = NEW+PRODUCING (2); sent = SHIP (1); closed = CLOSED (1).
    expect(screen.getByRole('tab', { name: 'Hammasi (5)' })).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'Kutib turgan (2)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Yuborgan (1)' })).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'Qabul qilgan (1)' }),
    ).toBeInTheDocument();
  });

  it('filters rows to the active status bucket', async () => {
    const user = userEvent.setup();
    mockList();
    renderWithProviders(<ReplenishmentPage />, { role: 'pm' });
    await screen.findByText('#1');
    // Default "Hammasi" shows all five (incl. CANCELLED #5).
    expect(screen.getByText('#5')).toBeInTheDocument();
    // Switch to "Kutib turgan" → only NEW (#1) + PRODUCING (#2).
    await user.click(screen.getByRole('tab', { name: 'Kutib turgan (2)' }));
    await waitFor(() => expect(screen.queryByText('#5')).toBeNull());
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    expect(screen.queryByText('#3')).toBeNull();
  });

  it('"Mening so‘rovlarim" narrows to the signed-in user', async () => {
    const user = userEvent.setup();
    mockList();
    renderWithProviders(<ReplenishmentPage />, { role: 'pm' }); // user.id = 1
    await screen.findByText('#1');
    await user.click(screen.getByRole('button', { name: /mening so.rovlarim/i }));
    // Only rows with created_by === 1 survive: #1, #3, #5.
    await waitFor(() => expect(screen.queryByText('#2')).toBeNull());
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#3')).toBeInTheDocument();
    expect(screen.queryByText('#4')).toBeNull();
    // Counts update to the my-filtered set: Hammasi (3), Kutib turgan (1).
    expect(screen.getByRole('tab', { name: 'Hammasi (3)' })).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'Kutib turgan (1)' }),
    ).toBeInTheDocument();
  });

  it('shows "So‘rov qo‘shish" for a central-warehouse manager with a location', async () => {
    mockList();
    renderWithProviders(<ReplenishmentPage />, {
      role: 'central_warehouse_manager',
      locationId: 21,
    });
    await screen.findByText('#1');
    expect(
      screen.getByRole('button', { name: /so.rov qo.shish/i }),
    ).toBeInTheDocument();
  });

  it('hides "So‘rov qo‘shish" for a PM (chain-wide, no own location)', async () => {
    mockList();
    renderWithProviders(<ReplenishmentPage />, { role: 'pm' });
    await screen.findByText('#1');
    expect(
      screen.queryByRole('button', { name: /so.rov qo.shish/i }),
    ).toBeNull();
  });

  it('hides "So‘rov qo‘shish" for a store manager with no active location', async () => {
    mockList();
    renderWithProviders(<ReplenishmentPage />, {
      role: 'store_manager',
      locationId: null,
    });
    await screen.findByText('#1');
    expect(
      screen.queryByRole('button', { name: /so.rov qo.shish/i }),
    ).toBeNull();
  });

  it('switches to the Tranzaksiyalar tab and shows the empty state', async () => {
    const user = userEvent.setup();
    mockList();
    renderWithProviders(<ReplenishmentPage />, { role: 'pm' });
    await screen.findByText('#1');
    await user.click(screen.getByRole('tab', { name: 'Tranzaksiyalar' }));
    expect(await screen.findByText('Hali harakat yo‘q.')).toBeInTheDocument();
  });
});
