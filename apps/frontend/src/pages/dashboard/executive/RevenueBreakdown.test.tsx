/**
 * F4.14 — RevenueBreakdown widget tests (donut redesign).
 *
 * The widget calls `GET /api/dashboard/revenue-breakdown?range=…` and
 * renders a donut (total in the centre) plus a legend row per payment
 * method. When the endpoint 404s, it must gracefully fall back to the
 * `fallbackTotal` and surface an inline "tayyor emas" hint rather than
 * an error state.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import { __clearApiQueryCache } from '@/hooks/useApiQuery';
import { RevenueBreakdown } from './RevenueBreakdown';

afterEach(() => {
  vi.restoreAllMocks();
  // useApiQuery's shared SWR cache is module-level; reset it so a cached
  // success from one case can't be served (stale-while-revalidate) into the
  // next — the 404/empty cases must see a true cold fetch.
  __clearApiQueryCache();
});

describe('RevenueBreakdown', () => {
  it('renders the total and one legend row per method from `methods` (incl. named custom)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/dashboard/revenue-breakdown')) {
        return Promise.resolve(
          jsonResponse(200, {
            total: 5_400_000,
            count: 40,
            byMethod: {
              cash: 2_000_000,
              card: 1_500_000,
              payme: 1_200_000,
              click: 400_000,
            },
            methods: [
              { key: 'cash', label: 'Naqd', amount: 2_000_000 },
              { key: 'card', label: 'Karta', amount: 1_500_000 },
              { key: 'payme', label: 'Payme', amount: 1_200_000 },
              { key: 'click', label: 'Click', amount: 400_000 },
              { key: 'pm_14', label: 'Доверительный платеж', amount: 300_000 },
            ],
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    renderWithProviders(
      <RevenueBreakdown range={{ range: 'today' }} fallbackTotal={0} />,
      { role: 'pm' },
    );
    await waitFor(() => {
      expect(screen.getByTestId('revenue-legend-cash')).toBeInTheDocument();
    });
    expect(screen.getByTestId('revenue-legend-card')).toBeInTheDocument();
    expect(screen.getByTestId('revenue-legend-payme')).toBeInTheDocument();
    expect(screen.getByTestId('revenue-legend-click')).toBeInTheDocument();
    // The custom named method renders by its own row + label.
    expect(screen.getByTestId('revenue-legend-pm_14')).toBeInTheDocument();
    // Method labels come straight from the backend `methods` list.
    expect(screen.getByText('Naqd')).toBeInTheDocument();
    expect(screen.getByText('Karta')).toBeInTheDocument();
    expect(screen.getByText('Payme')).toBeInTheDocument();
    expect(screen.getByText('Click')).toBeInTheDocument();
    expect(screen.getByText('Доверительный платеж')).toBeInTheDocument();
    // The donut centre shows the total in compact form (5.4M).
    const total = screen.getByTestId('revenue-breakdown-total');
    expect(total.textContent ?? '').toMatch(/5/);
    // The secondary stat tiles have been removed: the component is now just
    // donut + legend.
    expect(screen.queryByTestId('revenue-breakdown-stats')).toBeNull();
    expect(screen.queryByText("O'rtacha chek")).toBeNull();
    expect(screen.queryByText('Naqd ulushi')).toBeNull();
    expect(screen.queryByText('Naqdsiz ulush')).toBeNull();
    expect(screen.queryByText('Cheklar soni')).toBeNull();
  });

  it('hovering a legend row highlights the matching slice without crashing (no tooltip)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/dashboard/revenue-breakdown')) {
        return Promise.resolve(
          jsonResponse(200, {
            total: 3_000_000,
            count: 20,
            byMethod: { cash: 2_000_000, card: 1_000_000, payme: 0, click: 0 },
            methods: [
              { key: 'cash', label: 'Naqd', amount: 2_000_000 },
              { key: 'card', label: 'Karta', amount: 1_000_000 },
              // Zero-amount method: it has a legend row but NO donut slice,
              // so hovering it must be a safe no-op.
              { key: 'payme', label: 'Payme', amount: 0 },
            ],
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    renderWithProviders(
      <RevenueBreakdown range={{ range: 'today' }} fallbackTotal={0} />,
      { role: 'pm' },
    );
    const cashRow = await screen.findByTestId('revenue-legend-cash');
    // Default centre shows the grand total + "Jami tushum".
    const centerLabel = screen.getByTestId('revenue-breakdown-center-label');
    expect(centerLabel.textContent).toBe('Jami tushum');
    // Hover a slice-backed row, then a zero-amount row, then leave — the
    // component must keep rendering through every active-state transition.
    fireEvent.mouseEnter(cashRow);
    // Centre now reflects the hovered method's label.
    expect(
      screen.getByTestId('revenue-breakdown-center-label').textContent,
    ).toBe('Naqd');
    fireEvent.mouseLeave(cashRow);
    // Leaving reverts the centre to the grand total label.
    expect(
      screen.getByTestId('revenue-breakdown-center-label').textContent,
    ).toBe('Jami tushum');
    const zeroRow = screen.getByTestId('revenue-legend-payme');
    fireEvent.mouseEnter(zeroRow);
    fireEvent.mouseLeave(zeroRow);
    expect(screen.getByTestId('revenue-breakdown-legend')).toBeInTheDocument();
  });

  it('renders an extra "Boshqa" legend row when methods include an `other` entry', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, {
          total: 1_100_000,
          count: 8,
          byMethod: {
            cash: 500_000,
            card: 300_000,
            payme: 100_000,
            click: 100_000,
            other: 100_000,
          },
          methods: [
            { key: 'cash', label: 'Naqd', amount: 500_000 },
            { key: 'card', label: 'Karta', amount: 300_000 },
            { key: 'payme', label: 'Payme', amount: 100_000 },
            { key: 'click', label: 'Click', amount: 100_000 },
            { key: 'other', label: 'Boshqa', amount: 100_000 },
          ],
        }),
      ),
    );
    renderWithProviders(
      <RevenueBreakdown range={{ range: 'today' }} fallbackTotal={0} />,
      { role: 'pm' },
    );
    await waitFor(() => {
      expect(screen.getByTestId('revenue-legend-other')).toBeInTheDocument();
    });
    expect(screen.getByText('Boshqa')).toBeInTheDocument();
  });

  it('resolves to a zero-state (not a perpetual spinner) on an empty/zero response', async () => {
    // Defect: "BUGUNGI TUSHUM" stuck on "...yuklanmoqda…" forever when the
    // day had no/zero revenue. A successful response — even one without a
    // `byMethod` block — must clear the loading note and render real chips.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/dashboard/revenue-breakdown')) {
        // Zero-revenue day: server returns a total but no per-method block.
        return Promise.resolve(jsonResponse(200, { total: 0 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    renderWithProviders(
      <RevenueBreakdown range={{ range: 'today' }} fallbackTotal={0} />,
      { role: 'pm' },
    );
    // The cash legend row (zeroed) appears — proving we left the loading branch.
    await waitFor(() => {
      expect(screen.getByTestId('revenue-legend-cash')).toBeInTheDocument();
    });
    // The infinite-spinner note must be gone.
    expect(screen.queryByText(/yuklanmoqda/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('revenue-legend-card')).toBeInTheDocument();
  });

  it('renders "Bugungi tushum" by default and follows the selected period (EPIC 0.4)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/dashboard/revenue-breakdown')) {
        return Promise.resolve(jsonResponse(200, { total: 0 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const { rerender } = renderWithProviders(
      <RevenueBreakdown range={{ range: 'today' }} fallbackTotal={0} />,
      { role: 'pm' },
    );
    // The period title is shown in the subtitle ("To'lov usullari
    // bo'yicha · Bugungi tushum"), so match it as a substring.
    await waitFor(() => {
      expect(screen.getByText(/Bugungi tushum/)).toBeInTheDocument();
    });

    rerender(
      <RevenueBreakdown range={{ range: 'month' }} fallbackTotal={0} />,
    );
    expect(screen.getByText(/Bu oylik tushum/)).toBeInTheDocument();
    // The region's aria-label tracks the title too, for screen readers.
    expect(
      screen.getByRole('region', { name: /Bu oylik tushum brekdown/i }),
    ).toBeInTheDocument();
  });

  it('falls back to fallbackTotal + hint when the endpoint 404s', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        jsonResponse(404, {
          error: { code: 'NOT_FOUND', message: 'no endpoint' },
        }),
      ),
    );
    renderWithProviders(
      <RevenueBreakdown range={{ range: 'today' }} fallbackTotal={3_300_000} />,
      { role: 'pm' },
    );
    await waitFor(() => {
      expect(screen.getByText(/tayyor emas/i)).toBeInTheDocument();
    });
    // Total still shown from fallback so the headline number doesn't
    // vanish when the breakdown is unavailable.
    const total = screen.getByTestId('revenue-breakdown-total');
    expect(total.textContent ?? '').toMatch(/3/);
  });
});
