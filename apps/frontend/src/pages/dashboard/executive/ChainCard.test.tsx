import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChainCard, type ChainCardSummary } from './ChainCard';

const BASE_SUMMARY: ChainCardSummary = {
  countLabel: "1 bo'g'in",
  status: 'ok',
  stats: [
    { label: 'Xom-ashyo turlari', value: '378' },
    { label: "Min'dan past", value: '0' },
    { label: 'Bugun qabul', value: '42' },
    { label: 'Bugun chiqim', value: '38' },
  ],
};

describe('ChainCard', () => {
  it('renders title, count label and all four stats', () => {
    render(
      <ChainCard
        type="raw_warehouse"
        tone="raw"
        title="Xom-ashyo ombori"
        summary={BASE_SUMMARY}
        selected={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('Xom-ashyo ombori')).toBeInTheDocument();
    expect(screen.getByText("1 bo'g'in")).toBeInTheDocument();
    expect(screen.getByText('Xom-ashyo turlari')).toBeInTheDocument();
    expect(screen.getByText('378')).toBeInTheDocument();
    expect(screen.getByText('Bugun qabul')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Bugun chiqim')).toBeInTheDocument();
    expect(screen.getByText('38')).toBeInTheDocument();
  });

  it('marks danger stats with destructive text colour', () => {
    const dangerStats: ChainCardSummary['stats'] = [
      { label: 'Xom-ashyo turlari', value: '378' },
      { label: "Min'dan past", value: '5', tone: 'danger' },
      { label: 'Bugun qabul', value: '42' },
      { label: 'Bugun chiqim', value: '38' },
    ];
    render(
      <ChainCard
        type="store"
        tone="store"
        title="Do'konlar"
        summary={{ ...BASE_SUMMARY, stats: dangerStats }}
        selected={false}
        onSelect={() => {}}
      />,
    );
    const dangerValue = screen.getByText('5');
    expect(dangerValue.className).toMatch(/text-destructive/);
  });

  it('fires onSelect on click', () => {
    const onSelect = vi.fn();
    render(
      <ChainCard
        type="production"
        tone="production"
        title="Ishlab chiqarish"
        summary={BASE_SUMMARY}
        selected={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId('chain-card-production'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('fires onSelect on keyboard Enter', () => {
    const onSelect = vi.fn();
    render(
      <ChainCard
        type="production"
        tone="production"
        title="Ishlab chiqarish"
        summary={BASE_SUMMARY}
        selected={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.keyDown(screen.getByTestId('chain-card-production'), {
      key: 'Enter',
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('fires onSelect on keyboard Space', () => {
    const onSelect = vi.fn();
    render(
      <ChainCard
        type="store"
        tone="store"
        title="Do'konlar"
        summary={BASE_SUMMARY}
        selected={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.keyDown(screen.getByTestId('chain-card-store'), { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('sets aria-pressed="true" when selected', () => {
    render(
      <ChainCard
        type="supply"
        tone="supply"
        title="Ta'minot"
        summary={BASE_SUMMARY}
        selected={true}
        onSelect={() => {}}
      />,
    );
    const card = screen.getByTestId('chain-card-supply');
    expect(card.getAttribute('aria-pressed')).toBe('true');
    expect(card.getAttribute('data-selected')).toBe('true');
  });

  it('renders the status dot with destructive class when status=danger', () => {
    render(
      <ChainCard
        type="store"
        tone="store"
        title="Do'konlar"
        summary={{ ...BASE_SUMMARY, status: 'danger' }}
        selected={false}
        onSelect={() => {}}
      />,
    );
    const dot = screen.getByTestId('chain-card-status-store');
    expect(dot.className).toMatch(/bg-destructive/);
  });

  it('renders the status dot with warning class when status=warn', () => {
    render(
      <ChainCard
        type="central_warehouse"
        tone="central"
        title="Markaziy sklad"
        summary={{ ...BASE_SUMMARY, status: 'warn' }}
        selected={false}
        onSelect={() => {}}
      />,
    );
    const dot = screen.getByTestId('chain-card-status-central_warehouse');
    expect(dot.className).toMatch(/bg-warning/);
  });

  it('exposes role="button" and is focusable', () => {
    render(
      <ChainCard
        type="raw_warehouse"
        tone="raw"
        title="Xom-ashyo ombori"
        summary={BASE_SUMMARY}
        selected={false}
        onSelect={() => {}}
      />,
    );
    const card = screen.getByTestId('chain-card-raw_warehouse');
    expect(card.getAttribute('role')).toBe('button');
    expect(card.getAttribute('tabindex')).toBe('0');
    expect(card.getAttribute('aria-label')).toBe(
      "Xom-ashyo ombori bo'limini ochish",
    );
  });
});
