import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render-helpers';
import { HeroKpiStrip, type HeroKpiCard } from './HeroKpiStrip';

const CARDS: HeroKpiCard[] = [
  {
    id: 'sales',
    label: 'Bugungi savdo',
    value: { kind: 'currency', amount: 2_400_000 },
    tone: 'neutral',
    periodLabel: 'vs. kecha',
    delta: { value: 12, suffix: '%' },
    sparkline: [10, 12, 14, 13, 16],
  },
  {
    id: 'production',
    label: 'Faol zayafka',
    value: { kind: 'fraction', numerator: 12, denominator: 18 },
    tone: 'neutral',
  },
  {
    id: 'critical',
    label: 'Qizil pozitsiya',
    value: { kind: 'count', value: 4 },
    tone: 'danger',
  },
  {
    id: 'pending',
    label: 'Tasdiq kutmoqda',
    value: { kind: 'count', value: 3 },
    tone: 'warning',
  },
];

describe('HeroKpiStrip', () => {
  it('renders all four KPI cards', () => {
    renderWithProviders(<HeroKpiStrip cards={CARDS} />);
    expect(screen.getByText('Bugungi savdo')).toBeInTheDocument();
    expect(screen.getByText('Faol zayafka')).toBeInTheDocument();
    expect(screen.getByText('Qizil pozitsiya')).toBeInTheDocument();
    expect(screen.getByText('Tasdiq kutmoqda')).toBeInTheDocument();
  });

  it('renders the compact currency value', () => {
    renderWithProviders(<HeroKpiStrip cards={CARDS} />);
    expect(screen.getByText('2,4M')).toBeInTheDocument();
  });

  it('renders the fraction with a muted denominator', () => {
    renderWithProviders(<HeroKpiStrip cards={CARDS} />);
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('/18')).toBeInTheDocument();
  });

  it('applies the danger tone to the critical card', () => {
    renderWithProviders(<HeroKpiStrip cards={CARDS} />);
    const card = screen.getByTestId('hero-kpi-card-critical');
    expect(card.getAttribute('data-tone')).toBe('danger');
  });

  it('applies the warning tone to the pending card', () => {
    renderWithProviders(<HeroKpiStrip cards={CARDS} />);
    const card = screen.getByTestId('hero-kpi-card-pending');
    expect(card.getAttribute('data-tone')).toBe('warning');
  });

  it('mounts a sparkline container for cards that supply a series', () => {
    renderWithProviders(<HeroKpiStrip cards={CARDS} />);
    // Only the sales card carries a sparkline series.
    const spark = screen.getByTestId('hero-kpi-sparkline');
    expect(spark.getAttribute('data-tone')).toBe('neutral');
  });
});
