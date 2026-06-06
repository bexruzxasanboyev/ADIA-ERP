import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StoreBasketPanel } from './StoreBasketPanel';
import type { BasketItem } from './storeBasket';

function item(over: Partial<BasketItem> = {}): BasketItem {
  return {
    product_id: 1,
    product_name: 'Napoleon torti',
    product_unit: 'pcs',
    qty: 5,
    current_qty: 2,
    min_level: 6,
    max_level: 20,
    ...over,
  };
}

const noop = () => {};
const asyncNoop = async () => {};

function renderPanel(over: Partial<Parameters<typeof StoreBasketPanel>[0]> = {}) {
  return render(
    <StoreBasketPanel
      open
      onOpenChange={noop}
      items={[item()]}
      count={1}
      submitting={false}
      singleStoreId={7}
      setQty={noop}
      stepQty={noop}
      removeItem={noop}
      clear={noop}
      confirm={asyncNoop}
      onGoToProducts={noop}
      {...over}
    />,
  );
}

describe('StoreBasketPanel', () => {
  it('renders line items with the B2B meta line', () => {
    renderPanel();
    expect(screen.getByText('Napoleon torti')).toBeInTheDocument();
    // Header + footer both carry "Savat"/"ta mahsulot"; the meta line shows min/maks.
    expect(screen.getByText(/min 6 · maks 20/)).toBeInTheDocument();
  });

  it('shows the empty state and hides the footer CTA when the basket is empty', () => {
    renderPanel({ items: [], count: 0 });
    expect(screen.getByText('Savat bo‘sh')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Tasdiqlash va yuborish/ }),
    ).not.toBeInTheDocument();
  });

  it('disables the submit CTA and shows a hint when no single store is selected', () => {
    renderPanel({ singleStoreId: null });
    const cta = screen.getByRole('button', { name: /Tasdiqlash va yuborish/ });
    expect(cta).toBeDisabled();
    expect(
      screen.getByText('Yuborish uchun bitta do‘kon tanlang.'),
    ).toBeInTheDocument();
  });

  it('disables the submit CTA while submitting', () => {
    renderPanel({ submitting: true });
    expect(
      screen.getByRole('button', { name: /Tasdiqlash va yuborish/ }),
    ).toBeDisabled();
  });

  it('disables the submit CTA when every line qty is zero', () => {
    renderPanel({ items: [item({ qty: 0 })] });
    expect(
      screen.getByRole('button', { name: /Tasdiqlash va yuborish/ }),
    ).toBeDisabled();
  });

  it('shows only the count for mixed-unit baskets (no cross-unit sum)', () => {
    renderPanel({
      items: [
        item({ product_id: 1, product_unit: 'kg', qty: 3 }),
        item({ product_id: 2, product_unit: 'pcs', qty: 5 }),
      ],
      count: 2,
    });
    expect(screen.getByText('Jami: 2 ta mahsulot')).toBeInTheDocument();
  });

  it('exposes an accessible remove control per line', () => {
    const removeItem = vi.fn();
    renderPanel({ removeItem });
    expect(
      screen.getByRole('button', {
        name: 'Napoleon torti ni savatdan olib tashlash',
      }),
    ).toBeInTheDocument();
  });
});
