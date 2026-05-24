import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { ProductionPage } from './ProductionPage';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import type {
  ChainLayerOverview,
  Location,
  ProductionOrder,
  User,
} from '@/lib/types';

const OVERVIEW: ChainLayerOverview = {
  layer_type: 'production',
  locations: [
    {
      id: 10,
      name: 'Ishlab chiqarish',
      type: 'production',
      total_products: 0,
      below_min_count: 0,
      open_requests_count: 0,
    },
  ],
  totals: {
    total_locations: 1,
    total_products: 0,
    below_min_count: 0,
    open_requests_count: 0,
    active_production_orders: 0,
  },
  recent_movements: [],
};

const PRODUCTION_LOCATIONS: Location[] = [
  {
    id: 10,
    name: 'Ishlab chiqarish',
    type: 'production',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: 1,
    review_days: 7,
    safety_factor: 1.2,
  },
  {
    id: 11,
    name: 'Tort sexi',
    type: 'production',
    parent_id: 10,
    manager_user_id: 22,
    poster_storage_id: null,
    lead_time_days: 1,
    review_days: 7,
    safety_factor: 1.2,
  },
  {
    id: 12,
    name: 'Perojniy sexi',
    type: 'production',
    parent_id: 10,
    manager_user_id: 23,
    poster_storage_id: null,
    lead_time_days: 1,
    review_days: 7,
    safety_factor: 1.2,
  },
];

const ACTIVE_ORDERS: ProductionOrder[] = [];
const PENDING_ORDERS: ProductionOrder[] = [];

const PRODUCTION_USERS: User[] = [
  {
    id: 22,
    name: 'Hodim A',
    email: 'a@adia.test',
    role: 'production_manager',
    location_id: 11,
  },
];

function mockFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/dashboard/chain-layer/production')) {
        return Promise.resolve(jsonResponse(200, OVERVIEW));
      }
      if (url.includes('/api/stock')) {
        return Promise.resolve(jsonResponse(200, []));
      }
      if (url.includes('/api/production-orders?status=in_progress')) {
        return Promise.resolve(jsonResponse(200, ACTIVE_ORDERS));
      }
      if (url.includes('/api/production-orders?status=new')) {
        return Promise.resolve(jsonResponse(200, PENDING_ORDERS));
      }
      if (url.includes('/api/locations?type=production')) {
        return Promise.resolve(jsonResponse(200, PRODUCTION_LOCATIONS));
      }
      if (url.includes('/api/users')) {
        return Promise.resolve(jsonResponse(200, PRODUCTION_USERS));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    },
  );
}

describe('ProductionPage — sub-departments', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders sub-cehs grouped under their root production location', async () => {
    mockFetch();
    renderWithProviders(<ProductionPage />);

    expect(await screen.findByTestId('sub-department-11')).toBeInTheDocument();
    expect(screen.getByTestId('sub-department-12')).toBeInTheDocument();
    // Tort sexi card shows the assigned user (via primary location).
    const tortCard = screen.getByTestId('sub-department-11');
    expect(tortCard).toHaveTextContent('Tort sexi');
    expect(tortCard).toHaveTextContent('Hodim A');
    const perojniyCard = screen.getByTestId('sub-department-12');
    expect(perojniyCard).toHaveTextContent('Hodim biriktirilmagan');
  });
});
