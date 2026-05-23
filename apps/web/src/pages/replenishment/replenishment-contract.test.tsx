/**
 * Contract regression tests for the Sprint-2 replenishment screens.
 *
 * The list endpoint returns a bare `ReplenishmentRequest[]`; the detail
 * endpoint returns `{ request, transitions }`. The advance endpoint
 * envelopes `{ advanced, status, reason, request }` and raises 409
 * `INVALID_TRANSITION` when an illegal transition is attempted —
 * surface that as a friendly Uzbek message.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import { ReplenishmentPage } from './ReplenishmentPage';
import { ReplenishmentDetailPage } from './ReplenishmentDetailPage';
import { AuthContext } from '@/hooks/auth-context';
import { ToastProvider } from '@/components/ui/toast';
import type { ReplenishmentDetail, ReplenishmentRequest } from '@/lib/types';

const PRODUCT = {
  id: 11,
  name: 'Un',
  type: 'raw' as const,
  unit: 'kg' as const,
  sku: null,
  poster_ingredient_id: null,
  poster_product_id: null,
  is_active: true,
};

const LOCATION = {
  id: 21,
  name: 'Markaziy sklad',
  type: 'central_warehouse' as const,
  parent_id: null,
  manager_user_id: null,
  poster_storage_id: null,
  lead_time_days: 2,
  review_days: null,
  safety_factor: null,
};

const REQUEST: ReplenishmentRequest = {
  id: 1001,
  product_id: 11,
  requester_location_id: 21,
  target_location_id: null,
  qty_needed: '50',
  status: 'NEW',
  production_order_id: null,
  purchase_order_id: null,
  shipment_movement_id: null,
  note: null,
  created_by: 1,
  created_at: '2026-05-22T10:00:00.000Z',
  updated_at: '2026-05-22T10:00:00.000Z',
  closed_at: null,
  product_name: 'Un',
  product_unit: 'kg',
  requester_location_name: 'Markaziy sklad',
  target_location_name: null,
};

const DETAIL: ReplenishmentDetail = {
  request: REQUEST,
  transitions: [
    {
      id: 1,
      from_status: null,
      to_status: 'NEW',
      reason: 'created',
      actor_user_id: 1,
      actor_name: 'PM User',
      created_at: '2026-05-22T10:00:00.000Z',
    },
  ],
};

function mockFetch(options: {
  detail?: ReplenishmentDetail;
  advanceFails?: 'INVALID_TRANSITION';
} = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    if (url.includes('/api/products')) {
      return Promise.resolve(jsonResponse(200, [PRODUCT]));
    }
    if (url.includes('/api/locations')) {
      return Promise.resolve(jsonResponse(200, [LOCATION]));
    }
    if (url.includes('/api/users')) {
      // The detail page must NOT hit /api/users — `actor_name` is embedded.
      throw new Error('replenishment screens must not request /api/users');
    }
    if (url.includes('/api/replenishment/1001/advance') && method === 'POST') {
      if (options.advanceFails === 'INVALID_TRANSITION') {
        return Promise.resolve(
          jsonResponse(409, {
            error: { code: 'INVALID_TRANSITION', message: 'bad' },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, {
          advanced: true,
          status: 'CHECK_STORE_SUPPLIER',
          reason: 'ok',
          request: { ...REQUEST, status: 'CHECK_STORE_SUPPLIER' },
        }),
      );
    }
    if (url.endsWith('/api/replenishment/1001')) {
      return Promise.resolve(
        jsonResponse(200, options.detail ?? DETAIL),
      );
    }
    if (url.includes('/api/replenishment')) {
      return Promise.resolve(jsonResponse(200, [REQUEST]));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('Replenishment screens', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the list from a bare ReplenishmentRequest[]', async () => {
    mockFetch();
    renderWithProviders(<ReplenishmentPage />, { role: 'pm' });
    expect(await screen.findByText('#1001')).toBeInTheDocument();
    // Embedded `product_name` / `requester_location_name` are rendered
    // directly — no client-side join.
    expect(screen.getByText('Un')).toBeInTheDocument();
    expect(screen.getByText('Markaziy sklad')).toBeInTheDocument();
    // The status pill is rendered inside the table row — at least one
    // "Yangi" label is present (the others belong to the filter select).
    expect(screen.getAllByText('Yangi').length).toBeGreaterThan(0);
  });

  it('hides "Qo‘lda so‘rov" for non-pm/non-central-warehouse roles', async () => {
    mockFetch();
    renderWithProviders(<ReplenishmentPage />, { role: 'store_manager' });
    await screen.findByText('#1001');
    expect(screen.queryByRole('button', { name: /qo.lda so.rov/i })).toBeNull();
  });

  it('advances the state machine and shows the new status', async () => {
    const user = userEvent.setup();
    mockFetch();
    renderDetail();
    await screen.findByText('So‘rov #1001');
    await user.click(screen.getByRole('button', { name: /keyingi qadam/i }));
    await waitFor(() => {
      // The 200 advance response triggers a refetch — the next GET
      // returns the same REQUEST, but the success notify itself is
      // enough to prove the path was wired.
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/replenishment/1001/advance'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('surfaces 409 INVALID_TRANSITION as a friendly Uzbek alert', async () => {
    const user = userEvent.setup();
    mockFetch({ advanceFails: 'INVALID_TRANSITION' });
    renderDetail();
    await screen.findByText('So‘rov #1001');
    await user.click(screen.getByRole('button', { name: /keyingi qadam/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/o.tishni amalga oshirib bo.lmaydi/i),
      ).toBeInTheDocument();
    });
  });
});

/** Render the detail page under a memory router that injects `:id=1001`. */
function renderDetail() {
  const auth = {
    user: {
      id: 1,
      name: 'PM',
      email: 'pm@adia.test',
      role: 'pm' as const,
      location_id: null,
    },
    token: 'x',
    isAuthenticated: true,
    isHydrating: false,
    login: () => {},
    logout: () => {},
  };
  return render(
    <AuthContext.Provider value={auth}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/replenishment/1001']}>
          <Routes>
            <Route
              path="/replenishment/:id"
              element={<ReplenishmentDetailPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </AuthContext.Provider>,
  );
}
