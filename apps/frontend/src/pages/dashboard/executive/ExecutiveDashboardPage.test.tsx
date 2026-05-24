/**
 * F4.7 — Contract test for the executive dashboard.
 *
 * Pins the four mocked endpoints (overview, ecosystem, purchase orders,
 * replenishment) to the rendered UI: hero KPI numbers derive from the
 * overview + ecosystem payloads, the health bar surfaces all five
 * stages, the critical-alerts panel ranks zero-stock items first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { ExecutiveDashboardPage } from './ExecutiveDashboardPage';
import type {
  DashboardEcosystem,
  DashboardOverview,
  PurchaseOrder,
  ReplenishmentRequest,
} from '@/lib/types';

const OVERVIEW: DashboardOverview = {
  below_min: [
    {
      location_id: 7,
      location_name: 'Markaziy sklad',
      product_id: 1,
      product_name: 'Un',
      product_unit: 'kg',
      qty: 0,
      min_level: 10,
      max_level: 50,
      open_request_id: 42,
      open_request_status: 'NEW',
    },
  ],
  open_requests: {
    by_status: { NEW: 2, PRODUCING: 1 },
    total: 3,
    oldest_created_at: '2026-05-20T08:30:00.000Z',
  },
  production_plan: [
    {
      id: 501,
      product_id: 9,
      product_name: 'Pishloqli non',
      qty: 120,
      status: 'in_progress',
      location_id: 5,
      location_name: 'Sex 1',
      target_location_id: 7,
      target_location_name: 'Markaziy sklad',
      deadline: '2026-05-23',
    },
  ],
  recent_movements: [],
  kpis: {
    total_open_requests: 3,
    below_min_count: 1,
    active_production_orders: 12,
    pending_approvals: 4,
  },
};

const ECOSYSTEM: DashboardEcosystem = {
  poster_status: {
    last_sync_at: '2026-05-24T08:00:00.000Z',
    last_sync_status: 'ok',
    sync_errors_24h: 0,
    sales_today_count: 87,
    sales_today_sum: 2_400_000,
  },
  chain_flow: [
    {
      location_id: 1,
      location_name: 'Xom-ashyo',
      location_type: 'raw_warehouse',
      below_min_count: 0,
      open_requests_count: 0,
      total_products: 12,
    },
    {
      location_id: 2,
      location_name: 'Sex 1',
      location_type: 'production',
      below_min_count: 0,
      open_requests_count: 0,
      total_products: 6,
    },
    {
      location_id: 3,
      location_name: 'Ta’minot',
      location_type: 'supply',
      below_min_count: 0,
      open_requests_count: 0,
      total_products: 5,
    },
    {
      location_id: 4,
      location_name: 'Markaziy sklad',
      location_type: 'central_warehouse',
      below_min_count: 0,
      open_requests_count: 0,
      total_products: 25,
    },
    {
      location_id: 5,
      location_name: 'Do‘kon #1',
      location_type: 'store',
      below_min_count: 1,
      open_requests_count: 0,
      total_products: 18,
    },
  ],
  alerts_feed: [],
  sales_chart: {
    days: Array.from({ length: 14 }, (_, i) => ({
      date: `2026-05-${String(i + 11).padStart(2, '0')}`,
      qty: 100 + i * 5,
    })),
  },
};

const PURCHASE_ORDERS: PurchaseOrder[] = [
  {
    id: 88,
    product_id: 5,
    product_name: 'Un',
    qty: 100,
    supplier_id: null,
    target_location_id: 7,
    target_location_name: 'Markaziy sklad',
    status: 'draft',
    replenishment_id: null,
    manager_approved_by: null,
    manager_approved_at: null,
    manager_approved_name: null,
    keeper_approved_by: null,
    keeper_approved_at: null,
    keeper_approved_name: null,
    supplier_name: null,
    received_movement_id: null,
    note: null,
    created_by: null,
    created_at: '2026-05-24T08:00:00.000Z',
    updated_at: '2026-05-24T08:00:00.000Z',
  },
];

const REPLENISHMENTS: ReplenishmentRequest[] = [];

function mockAll() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/dashboard/overview')) {
      return Promise.resolve(jsonResponse(200, OVERVIEW));
    }
    if (url.includes('/api/dashboard/ecosystem')) {
      return Promise.resolve(jsonResponse(200, ECOSYSTEM));
    }
    if (url.includes('/api/purchase-orders')) {
      return Promise.resolve(jsonResponse(200, PURCHASE_ORDERS));
    }
    if (url.includes('/api/replenishment')) {
      return Promise.resolve(jsonResponse(200, REPLENISHMENTS));
    }
    if (url.includes('/api/forecasts')) {
      return Promise.resolve(jsonResponse(200, { items: [] }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('ExecutiveDashboardPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the four hero KPI cards', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    expect(await screen.findByText('Bugungi savdo')).toBeInTheDocument();
    expect(screen.getByText('Faol zayafka')).toBeInTheDocument();
    expect(screen.getByText('Qizil pozitsiya')).toBeInTheDocument();
    expect(screen.getByText('Tasdiq kutmoqda')).toBeInTheDocument();
  });

  it('renders the compact currency for today\'s sales', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    expect(await screen.findByText('2,4M')).toBeInTheDocument();
  });

  it('renders the production fraction 12 / 12', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    await waitFor(() => {
      expect(screen.getByTestId('hero-kpi-card-production')).toBeInTheDocument();
    });
    const fractionCard = screen.getByTestId('hero-kpi-card-production');
    expect(fractionCard.textContent).toMatch(/12/);
  });

  it('marks the critical KPI card with the danger tone when below_min > 0', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    const card = await screen.findByTestId('hero-kpi-card-critical');
    expect(card.getAttribute('data-tone')).toBe('danger');
  });

  it('marks the pending KPI card with the warning tone when approvals > 0', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    const card = await screen.findByTestId('hero-kpi-card-pending');
    expect(card.getAttribute('data-tone')).toBe('warning');
  });

  it('renders the ecosystem health bar with five stages', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    expect(
      await screen.findByTestId('ecosystem-health-bar'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('health-pill-raw_warehouse')).toBeInTheDocument();
    expect(screen.getByTestId('health-pill-production')).toBeInTheDocument();
    expect(screen.getByTestId('health-pill-supply')).toBeInTheDocument();
    expect(
      screen.getByTestId('health-pill-central_warehouse'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('health-pill-store')).toBeInTheDocument();
  });

  it('lists the critical zero-stock item at the top of CriticalAlerts', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    expect(await screen.findByTestId('critical-alerts')).toBeInTheDocument();
    expect(screen.getAllByText('Un').length).toBeGreaterThan(0);
  });

  it('surfaces the draft purchase order in MyActionsList', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    expect(await screen.findByTestId('my-actions-list')).toBeInTheDocument();
    expect(screen.getByText('Sotib olish: Un')).toBeInTheDocument();
  });
});
