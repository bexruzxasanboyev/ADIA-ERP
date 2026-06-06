/**
 * TopProducts widget tests.
 *
 * The widget calls `GET /api/dashboard/top-products?range=…&limit=5` and
 * renders the period's best-selling products as a ranked list (rank badge,
 * name, qty + unit, revenue, share). On 404 it degrades to an inline hint;
 * on an empty `products` array it shows a calm "Ma'lumot yo'q" message.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import { __clearApiQueryCache } from '@/hooks/useApiQuery';
import { TopProducts, relativeBarPct } from './TopProducts';

afterEach(() => {
  vi.restoreAllMocks();
  // useApiQuery's shared SWR cache is module-level; reset it so a cached
  // success from one case can't be served (stale-while-revalidate) into the
  // next — the 404/empty cases must see a true cold fetch.
  __clearApiQueryCache();
});

/** Mock the top-products endpoint with a fixed three-row ranking. */
function mockTopProducts() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/dashboard/top-products')) {
      return Promise.resolve(
        jsonResponse(200, {
          from: '2026-06-06',
          to: '2026-06-06',
          spot_id: null,
          products: [
            { product_id: 1, name: 'Napoleon', qty: 66, unit: 'p', revenue: 3_300_000, share: 0.45 },
            { product_id: 2, name: 'Medovik', qty: 40, unit: 'p', revenue: 2_000_000, share: 0.27 },
            { product_id: 3, name: 'Un (oliy nav)', qty: 12, unit: 'kg', revenue: 1_200_000, share: 0.16 },
          ],
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('relativeBarPct', () => {
  it('draws the bar relative to the top product (max), not share-of-total', () => {
    // #1 fills the bar; the rest are proportional to it.
    expect(relativeBarPct(3_300_000, 3_300_000)).toBe(100);
    expect(relativeBarPct(1_650_000, 3_300_000)).toBe(50);
    expect(relativeBarPct(0, 3_300_000)).toBe(0);
  });

  it('guards a zero / non-finite max to avoid divide-by-zero', () => {
    expect(relativeBarPct(1000, 0)).toBe(0);
    expect(relativeBarPct(1000, Number.NaN)).toBe(0);
    expect(relativeBarPct(Number.NaN, 1000)).toBe(0);
  });

  it('clamps to 0..100', () => {
    expect(relativeBarPct(5000, 1000)).toBe(100);
    expect(relativeBarPct(-100, 1000)).toBe(0);
  });
});

describe('TopProducts', () => {
  it('renders ranked product names, qty + unit, and ranks from the response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/dashboard/top-products')) {
        return Promise.resolve(
          jsonResponse(200, {
            from: '2026-06-06',
            to: '2026-06-06',
            spot_id: null,
            products: [
              { product_id: 1, name: 'Napoleon', qty: 66, unit: 'p', revenue: 3_300_000, share: 0.45 },
              { product_id: 2, name: 'Medovik', qty: 40, unit: 'p', revenue: 2_000_000, share: 0.27 },
              { product_id: 3, name: 'Un (oliy nav)', qty: 12, unit: 'kg', revenue: 1_200_000, share: 0.16 },
            ],
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderWithProviders(<TopProducts range={{ range: 'today' }} />, {
      role: 'pm',
    });

    await waitFor(() => {
      expect(screen.getByTestId('top-products-list')).toBeInTheDocument();
    });

    // Each product renders a row keyed by product id.
    expect(screen.getByTestId('top-product-1')).toBeInTheDocument();
    expect(screen.getByTestId('top-product-2')).toBeInTheDocument();
    expect(screen.getByTestId('top-product-3')).toBeInTheDocument();

    // Names render.
    expect(screen.getByText('Napoleon')).toBeInTheDocument();
    expect(screen.getByText('Medovik')).toBeInTheDocument();
    expect(screen.getByText('Un (oliy nav)')).toBeInTheDocument();

    // Rank badges #1..#3 appear in order.
    const ranks = screen.getAllByText(/^[123]$/);
    expect(ranks.map((n) => n.textContent)).toEqual(['1', '2', '3']);

    // Qty maps unit 'p' → "dona" and keeps 'kg'.
    expect(screen.getByText(/66\s*dona/)).toBeInTheDocument();
    expect(screen.getByText(/12\s*kg/)).toBeInTheDocument();
  });

  it('shows the period subtitle and follows the selected range', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/dashboard/top-products')) {
        return Promise.resolve(
          jsonResponse(200, {
            from: '2026-06-01',
            to: '2026-06-30',
            spot_id: null,
            products: [],
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const { rerender } = renderWithProviders(
      <TopProducts range={{ range: 'today' }} />,
      { role: 'pm' },
    );

    await waitFor(() => {
      expect(screen.getByText(/Top 5 · Bugungi tushum/)).toBeInTheDocument();
    });

    rerender(<TopProducts range={{ range: 'month' }} />);
    expect(screen.getByText(/Top 5 · Bu oylik tushum/)).toBeInTheDocument();
  });

  it('renders a calm empty state when products is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, {
          from: '2026-06-06',
          to: '2026-06-06',
          spot_id: null,
          products: [],
        }),
      ),
    );

    renderWithProviders(<TopProducts range={{ range: 'today' }} />, {
      role: 'pm',
    });

    await waitFor(() => {
      expect(screen.getByText(/Ma'lumot yo'q/)).toBeInTheDocument();
    });
  });

  it('falls back to an inline hint when the endpoint 404s', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        jsonResponse(404, {
          error: { code: 'NOT_FOUND', message: 'no endpoint' },
        }),
      ),
    );

    renderWithProviders(<TopProducts range={{ range: 'today' }} />, {
      role: 'pm',
    });

    await waitFor(() => {
      expect(screen.getByText(/tayyor emas/i)).toBeInTheDocument();
    });
  });

  it('exposes the card as a button with a "Batafsil" affordance', async () => {
    mockTopProducts();
    renderWithProviders(<TopProducts range={{ range: 'today' }} />, {
      role: 'pm',
    });

    const card = await screen.findByTestId('top-products');
    expect(card).toHaveAttribute('role', 'button');
    expect(card).toHaveAttribute('tabindex', '0');
    expect(card).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByText('Batafsil')).toBeInTheDocument();
  });

  it('opens the full-ranking sheet on click with title, count and rows', async () => {
    mockTopProducts();
    renderWithProviders(<TopProducts range={{ range: 'today' }} />, {
      role: 'pm',
    });

    fireEvent.click(await screen.findByTestId('top-products'));

    // Sheet (dialog) opens with the full list.
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/Eng ko.p sotilgan mahsulotlar/),
    ).toBeInTheDocument();
    // Subtitle carries the product count + active period.
    expect(
      within(dialog).getByText(/3 ta mahsulot · Bugungi tushum/),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        within(dialog).getByTestId('top-products-sheet-list'),
      ).toBeInTheDocument();
    });
    expect(within(dialog).getByText('Napoleon')).toBeInTheDocument();
    expect(within(dialog).getByText('Medovik')).toBeInTheDocument();
    expect(within(dialog).getByText('Un (oliy nav)')).toBeInTheDocument();
  });

  it('opens the sheet via keyboard (Enter)', async () => {
    mockTopProducts();
    renderWithProviders(<TopProducts range={{ range: 'today' }} />, {
      role: 'pm',
    });

    const card = await screen.findByTestId('top-products');
    fireEvent.keyDown(card, { key: 'Enter' });

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('shows a skeleton in the sheet while the full ranking loads', async () => {
    // First fetch (the card's Top-5) resolves; the sheet's full-list fetch
    // is left pending so the loading skeleton stays mounted.
    let pendingCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/dashboard/top-products')) {
        pendingCount += 1;
        // The card requests limit=5 first; let it resolve so the card paints.
        // The sheet requests limit=200 — keep that one pending forever.
        if (url.includes('limit=200')) {
          return new Promise<Response>(() => {});
        }
        return Promise.resolve(
          jsonResponse(200, {
            from: '2026-06-06',
            to: '2026-06-06',
            spot_id: null,
            products: [
              { product_id: 1, name: 'Napoleon', qty: 66, unit: 'p', revenue: 3_300_000, share: 0.45 },
            ],
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderWithProviders(<TopProducts range={{ range: 'today' }} />, {
      role: 'pm',
    });

    fireEvent.click(await screen.findByTestId('top-products'));
    const dialog = await screen.findByRole('dialog');

    // Header + search stay visible while the list area shows a skeleton.
    expect(
      within(dialog).getByText(/Eng ko.p sotilgan mahsulotlar/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText(/Mahsulot nomi bo.yicha qidirish/),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        within(dialog).getByTestId('top-products-sheet-skeleton'),
      ).toBeInTheDocument();
    });
    expect(pendingCount).toBeGreaterThan(0);
  });

  it('filters the full list by product name (client-side)', async () => {
    mockTopProducts();
    renderWithProviders(<TopProducts range={{ range: 'today' }} />, {
      role: 'pm',
    });

    fireEvent.click(await screen.findByTestId('top-products'));
    const dialog = await screen.findByRole('dialog');

    await waitFor(() => {
      expect(within(dialog).getByText('Napoleon')).toBeInTheDocument();
    });

    const search = within(dialog).getByLabelText(
      /Mahsulot nomi bo.yicha qidirish/,
    );
    fireEvent.change(search, { target: { value: 'medov' } });

    expect(within(dialog).getByText('Medovik')).toBeInTheDocument();
    expect(within(dialog).queryByText('Napoleon')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Un (oliy nav)')).not.toBeInTheDocument();
  });
});
