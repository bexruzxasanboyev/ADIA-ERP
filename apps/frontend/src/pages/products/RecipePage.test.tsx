/**
 * RecipePage — read-only recipe view.
 *
 * Recipes are Poster-sourced and not edited in-app (owner decision), so the
 * page renders only the nested `tree` breakdown plus a SMART empty state:
 *   - PRODUCED product with no recipe  → amber warning "Posterda kiritilishi…"
 *   - resale/base product with no recipe → neutral "Sotib olinadigan…"
 *
 * The first test also guards the wrapped-envelope regression: the page reads
 * `result.tree` / `result.total_cost` from `{ product_id, recipe, tree, … }`
 * and must NOT surface "Retseptni yuklab bo‘lmadi." The page resolves the
 * product name/category from the shared `/api/products` list, so both
 * endpoints are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { AuthContext, type AuthContextValue } from '@/hooks/auth-context';
import { RecipePage } from './RecipePage';
import { jsonResponse } from '@/test/render-helpers';
import type { Product, User } from '@/lib/types';

const FLOUR: Product = {
  id: 1,
  name: 'Un (oliy nav)',
  type: 'raw',
  unit: 'kg',
  sku: 'RAW-FLOUR',
  poster_product_id: null,
  poster_ingredient_id: null,
  is_active: true,
  poster_category: null,
};

const CAKE: Product = {
  id: 5,
  name: 'Shokoladli tort',
  type: 'finished',
  unit: 'pcs',
  sku: 'FIN-CHOCO-CAKE',
  poster_product_id: null,
  poster_ingredient_id: null,
  is_active: true,
  poster_category: { id: 9, name: 'Торты' },
};

const COLA: Product = {
  id: 7,
  name: 'Coca-Cola 0.5',
  type: 'finished',
  unit: 'pcs',
  sku: 'RESALE-COLA',
  poster_product_id: null,
  poster_ingredient_id: null,
  is_active: true,
  poster_category: { id: 3, name: 'Холодные напитки' },
};

const PM: User = {
  id: 1,
  name: 'Test PM',
  username: 'pm',
  role: 'pm',
  location_id: null,
};

function fakeAuth(user: User): AuthContextValue {
  return {
    user,
    token: 'test-token',
    isAuthenticated: true,
    isHydrating: false,
    locations: [],
    activeLocationId: null,
    login: () => {},
    logout: async () => {},
    updateUser: () => {},
    setActiveLocation: async () => {},
  };
}

/** Mount RecipePage at `/products/:id/recipe` with router + auth + toast. */
function renderRecipePage(productId: number) {
  return render(
    <AuthContext.Provider value={fakeAuth(PM)}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/products/${productId}/recipe`]}>
          <Routes>
            <Route path="/products/:productId/recipe" element={<RecipePage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </AuthContext.Provider>,
  );
}

/** Stub fetch: recipe endpoint returns `recipePayload`, list returns products. */
function mockFetch(recipePayload: unknown, products: Product[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/recipe')) {
      return Promise.resolve(jsonResponse(200, recipePayload));
    }
    return Promise.resolve(jsonResponse(200, products));
  });
}

describe('RecipePage — read-only recipe view', () => {
  beforeEach(() => {
    localStorage.setItem('adia.token', 'fake-jwt');
  });
  afterEach(() => {
    localStorage.removeItem('adia.token');
    vi.restoreAllMocks();
  });

  it('renders the nested tree from `{ product_id, recipe, tree, … }` (spec §4.3)', async () => {
    mockFetch(
      {
        product_id: 5,
        recipe: [
          { component_product_id: 1, qty_per_unit: 0.5, stage: 'dough' },
        ],
        tree: [
          {
            component_product_id: 1,
            name: 'Un (oliy nav)',
            type: 'raw',
            unit: 'kg',
            qty_per_unit: 0.5,
            brutto: null,
            netto: null,
            unit_cost: null,
            line_cost: null,
            total_cost: null,
            children: [],
          },
        ],
        total_cost: null,
      },
      [FLOUR, CAKE],
    );

    await act(async () => {
      renderRecipePage(5);
    });

    await waitFor(() => {
      expect(screen.queryByText(/Retseptni yuklab bo/i)).toBeNull();
    });
    // Product name resolved from the products list into the header (it may
    // also appear inside the breakdown, so allow multiple matches).
    expect(screen.getAllByText(/Shokoladli tort/).length).toBeGreaterThan(0);
    // The flour component appears in the read-only breakdown tree.
    expect(screen.getByText(/Un \(oliy nav\)/)).toBeTruthy();
  });

  it('shows an amber WARNING empty state for a PRODUCED product with no recipe', async () => {
    mockFetch(
      { product_id: 5, recipe: [], tree: [], total_cost: null },
      [FLOUR, CAKE],
    );

    await act(async () => {
      renderRecipePage(5);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Posterda kiritilishi kerak/i),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/Sotib olinadigan/i)).toBeNull();
  });

  it('shows a NEUTRAL empty state for a resale product with no recipe', async () => {
    mockFetch(
      { product_id: 7, recipe: [], tree: [], total_cost: null },
      [COLA],
    );

    await act(async () => {
      renderRecipePage(7);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Sotib olinadigan mahsulot — retseptsiz/i),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/Posterda kiritilishi kerak/i)).toBeNull();
  });
});
