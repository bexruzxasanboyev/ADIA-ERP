/**
 * ProductsPage feature tests.
 *
 * The owner reversed the earlier "type tabs + category chips" layout — TYPE,
 * CATEGORY and UNIT all now live inside the single Filter popover (rendered as
 * tabs). The always-visible search box stays.
 *
 *   - Filter popover TYPE dimension narrows the visible set;
 *   - Filter popover CATEGORY dimension narrows the visible set;
 *   - Filter popover UNIT dimension narrows the set;
 *   - translit search (Latin query → Cyrillic product name);
 *   - smart category — Г/П prefix is treated as "Tayyor mahsulot";
 *   - default = no filter (every type visible).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { ProductsPage } from './ProductsPage';
import type { Product } from '@/lib/types';

function product(overrides: Partial<Product>): Product {
  return {
    id: 1,
    name: 'X',
    type: 'finished',
    unit: 'pcs',
    sku: null,
    poster_ingredient_id: null,
    poster_product_id: null,
    is_active: true,
    poster_category: null,
    ...overrides,
  };
}

const FLOUR = product({ id: 1, name: 'Un (oliy nav)', type: 'raw', unit: 'kg' });
const CHOCO_CAKE = product({
  id: 2,
  name: 'Шоколадный торт',
  type: 'finished',
  unit: 'pcs',
});
const READY_ECLAIR = product({
  id: 3,
  name: 'Г/П Эклер',
  type: 'semi',
  unit: 'pcs',
});

function mockProducts(items: Product[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/products')) {
      return Promise.resolve(jsonResponse(200, items));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('ProductsPage — filter popover UX', () => {
  afterEach(() => vi.restoreAllMocks());

  it('defaults to the finished type tab (EPIC 1.4) — hides raw by default', async () => {
    mockProducts([FLOUR, CHOCO_CAKE]);
    renderWithProviders(<ProductsPage />);

    // The catalogue opens on "tayyor mahsulot" so a manager lands on the
    // sellable set; the raw "Un (oliy nav)" is hidden until the user
    // switches the type tab back to "Hammasi".
    expect(await screen.findByText('Шоколадный торт')).toBeInTheDocument();
    expect(screen.queryByText('Un (oliy nav)')).not.toBeInTheDocument();
  });

  it('shows every type once the "Hammasi" tab is selected', async () => {
    const user = userEvent.setup();
    mockProducts([FLOUR, CHOCO_CAKE]);
    renderWithProviders(<ProductsPage />);

    await screen.findByText('Шоколадный торт');
    await user.click(screen.getByRole('tab', { name: /Hammasi/ }));
    expect(await screen.findByText('Un (oliy nav)')).toBeInTheDocument();
  });

  it('TYPE/CATEGORY options live inside the Filter popover', async () => {
    const user = userEvent.setup();
    const torte = product({
      id: 20,
      name: 'Медовик',
      type: 'finished',
      poster_category: { id: 1, name: 'Торты' },
    });
    mockProducts([FLOUR, torte]);
    renderWithProviders(<ProductsPage />);

    await screen.findByText('Медовик');
    // No page-level type tab row, no category chip row exist anymore.
    expect(
      screen.queryByRole('tablist', { name: 'Mahsulot turi' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Filtrlarni ochish' }));
    // Tabs for all three dimensions are present inside the popover.
    expect(screen.getByRole('tab', { name: /Tur/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Kategoriya/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Birlik/ })).toBeInTheDocument();
    // The TYPE group (default tab) lists the three product types as options.
    expect(
      screen.getByRole('checkbox', { name: 'Tayyor mahsulot' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'Xom-ashyo' }),
    ).toBeInTheDocument();
  });

  it('filter popover TYPE dimension narrows to raw products', async () => {
    const user = userEvent.setup();
    mockProducts([FLOUR, CHOCO_CAKE]);
    renderWithProviders(<ProductsPage />);

    await screen.findByText('Шоколадный торт');
    await user.click(screen.getByRole('button', { name: 'Filtrlarni ochish' }));
    await user.click(screen.getByRole('checkbox', { name: 'Xom-ashyo' }));
    await user.click(screen.getByRole('button', { name: 'Qo‘llash' }));

    await waitFor(() => {
      expect(screen.getByText('Un (oliy nav)')).toBeInTheDocument();
      expect(screen.queryByText('Шоколадный торт')).not.toBeInTheDocument();
    });
  });

  it('filter popover CATEGORY dimension narrows the set', async () => {
    const user = userEvent.setup();
    const torte = product({
      id: 20,
      name: 'Медовик',
      type: 'finished',
      poster_category: { id: 1, name: 'Торты' },
    });
    const drink = product({
      id: 21,
      name: 'Cola',
      type: 'finished',
      poster_category: { id: 2, name: 'Напитки' },
    });
    mockProducts([torte, drink]);
    renderWithProviders(<ProductsPage />);

    await screen.findByText('Медовик');
    await user.click(screen.getByRole('button', { name: 'Filtrlarni ochish' }));
    await user.click(screen.getByRole('tab', { name: /Kategoriya/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Торты' }));
    await user.click(screen.getByRole('button', { name: 'Qo‘llash' }));

    await waitFor(() => {
      expect(screen.getByText('Медовик')).toBeInTheDocument();
      expect(screen.queryByText('Cola')).not.toBeInTheDocument();
    });
  });

  it('treats a Г/П-prefixed product as finished', async () => {
    const user = userEvent.setup();
    mockProducts([READY_ECLAIR]);
    renderWithProviders(<ProductsPage />);

    // Despite stored type=semi, the Г/П prefix surfaces it under a
    // "Tayyor mahsulot" type filter.
    expect(await screen.findByText('Г/П Эклер')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Filtrlarni ochish' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'Tayyor mahsulot' }),
    );
    await user.click(screen.getByRole('button', { name: 'Qo‘llash' }));

    await waitFor(() =>
      expect(screen.getByText('Г/П Эклер')).toBeInTheDocument(),
    );
  });

  it('finds a Cyrillic product name via a Latin query', async () => {
    const user = userEvent.setup();
    mockProducts([CHOCO_CAKE, product({ id: 9, name: 'Наполеон' })]);
    renderWithProviders(<ProductsPage />);

    await screen.findByText('Шоколадный торт');
    await user.type(screen.getByLabelText('Mahsulot qidirish'), 'shokolad');

    await waitFor(() => {
      expect(screen.getByText('Шоколадный торт')).toBeInTheDocument();
      expect(screen.queryByText('Наполеон')).not.toBeInTheDocument();
    });
  });

  it('filter popover UNIT dimension narrows the set', async () => {
    const user = userEvent.setup();
    mockProducts([FLOUR, CHOCO_CAKE]); // FLOUR=kg, CHOCO_CAKE=pcs
    renderWithProviders(<ProductsPage />);

    await screen.findByText('Шоколадный торт');
    await user.click(screen.getByRole('button', { name: 'Filtrlarni ochish' }));
    await user.click(screen.getByRole('tab', { name: /Birlik/ }));
    await user.click(screen.getByRole('checkbox', { name: 'kg' }));
    await user.click(screen.getByRole('button', { name: 'Qo‘llash' }));

    await waitFor(() => {
      expect(screen.getByText('Un (oliy nav)')).toBeInTheDocument();
      expect(screen.queryByText('Шоколадный торт')).not.toBeInTheDocument();
    });
  });

  it('keeps the search box always visible alongside the Filter trigger', async () => {
    mockProducts([CHOCO_CAKE]);
    renderWithProviders(<ProductsPage />);

    expect(await screen.findByText('Шоколадный торт')).toBeInTheDocument();
    expect(screen.getByLabelText('Mahsulot qidirish')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Filtrlarni ochish' }),
    ).toBeVisible();
  });

  it('shows a result count', async () => {
    mockProducts([CHOCO_CAKE, READY_ECLAIR]);
    renderWithProviders(<ProductsPage />);
    expect(await screen.findByText('2 ta mahsulot')).toBeInTheDocument();
  });
});
