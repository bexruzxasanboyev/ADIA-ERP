import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DateRangeFilter,
  dateRangeToQuery,
  type DateRangeValue,
} from './DateRangeFilter';

function Harness({ onChange }: { onChange?: (v: DateRangeValue) => void }) {
  const [value, setValue] = useState<DateRangeValue>({ range: 'today' });
  return (
    <DateRangeFilter
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe('DateRangeFilter', () => {
  it('exposes preset tabs and highlights the active one', () => {
    render(<Harness />);

    const bugun = screen.getByRole('tab', { name: 'Bugun' });
    const hafta = screen.getByRole('tab', { name: 'Hafta' });
    const buOy = screen.getByRole('tab', { name: 'Bu oy' });

    expect(bugun).toHaveAttribute('aria-selected', 'true');
    expect(hafta).toHaveAttribute('aria-selected', 'false');
    expect(buOy).toHaveAttribute('aria-selected', 'false');
  });

  it('switches between presets when tabs are clicked', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Hafta' }));

    expect(onChange).toHaveBeenLastCalledWith({ range: 'week' });
    expect(screen.getByRole('tab', { name: 'Hafta' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('opens the custom calendar picker and applies a custom range', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /Sana oralig/ }));

    const from = await screen.findByLabelText('Boshlanish');
    const to = screen.getByLabelText('Tugash');
    await user.clear(from);
    await user.type(from, '2026-05-01');
    await user.clear(to);
    await user.type(to, '2026-05-15');
    await user.click(screen.getByRole('button', { name: "Qo'llash" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({
        range: 'custom',
        from: '2026-05-01',
        to: '2026-05-15',
      });
    });
  });

  it('rejects an inverted custom range', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /Sana oralig/ }));
    const from = await screen.findByLabelText('Boshlanish');
    const to = screen.getByLabelText('Tugash');
    await user.clear(from);
    await user.type(from, '2026-05-20');
    await user.clear(to);
    await user.type(to, '2026-05-01');
    await user.click(screen.getByRole('button', { name: "Qo'llash" }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /boshlanish/i,
    );
  });
});

describe('dateRangeToQuery', () => {
  it('serialises preset ranges to a single param', () => {
    expect(dateRangeToQuery({ range: 'today' })).toBe('range=today');
    expect(dateRangeToQuery({ range: 'week' })).toBe('range=week');
    expect(dateRangeToQuery({ range: 'month' })).toBe('range=month');
  });

  it('serialises custom ranges with from/to', () => {
    expect(
      dateRangeToQuery({
        range: 'custom',
        from: '2026-05-01',
        to: '2026-05-15',
      }),
    ).toBe('range=custom&from=2026-05-01&to=2026-05-15');
  });

  it('falls back to range=custom alone when from/to are missing', () => {
    expect(dateRangeToQuery({ range: 'custom' })).toBe('range=custom');
  });
});
