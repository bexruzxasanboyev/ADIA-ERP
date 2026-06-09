import { type ComponentType, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertOctagon,
  CalendarClock,
  PackageX,
  Receipt,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatPlainNumber, formatQty } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { DiscrepanciesResponse } from '@/lib/types';

/**
 * SIFAT & INTEGRITET — the four self-correction signals the boshliq wants
 * surfaced on the Command Center (owner-approved, 2026-06):
 *
 *   1. Kassa tafovuti (Ortiqcha sotuv) — Poster cheque sold MORE than was on
 *      hand → wrong-keyed count. Red when > 0. Links to /cashier/discrepancies.
 *   2. Manfiy ostatka — stock that went below zero. Red when > 0.
 *   3. Muddati o'tayotgan — shelf-life aging alerts (warning + critical).
 *   4. Brak % — defect ratio across receipts in the range. The endpoint is
 *      being added by a parallel agent, so it may 404 briefly; we degrade to
 *      "—" gracefully and never block the page.
 *
 * Each tile mirrors the KpiCard visual language used across the app
 * (uppercase muted label, big tabular-nums value, status colour semantics).
 */
export interface QualityRowProps {
  /** `dateRangeToQuery(range)` — drives the brak-summary fetch. */
  rangeQuery: string;
  className?: string;
}

/** Shelf-life aging item — only the fields this tile needs. */
interface AgingAlertLite {
  urgency: 'warning' | 'critical';
}
interface AgingAlertsResponse {
  items: AgingAlertLite[];
}

/**
 * Brak summary — defined INLINE (not in types.ts) on purpose: a parallel
 * agent owns the endpoint + the canonical type, so keeping this local avoids
 * a merge collision. Mirrors `GET /api/dashboard/brak-summary`.
 */
interface BrakSummary {
  /** Defect ratio in [0, 1] — share of received qty rejected as brak. */
  brak_ratio: number;
  /** Total brak quantity over the range. */
  total_brak_qty: number;
  by_source?: Array<{ source: string; qty: number }>;
  top?: Array<{ product_name: string; qty: number }>;
}

type Tone = 'default' | 'warning' | 'danger';

const VALUE_TONE: Record<Tone, string> = {
  default: 'text-foreground',
  warning: 'text-warning',
  danger: 'text-destructive',
};

const ICON_TONE: Record<Tone, string> = {
  default: 'text-muted-foreground',
  warning: 'text-warning',
  danger: 'text-destructive',
};

interface QualityTile {
  testId: string;
  label: string;
  value: string;
  caption: string;
  tone: Tone;
  Icon: ComponentType<{ className?: string }>;
  href?: string;
  loading?: boolean;
}

export function QualityRow({ rangeQuery, className }: QualityRowProps) {
  // Discrepancies feed BOTH the kassa-tafovuti and manfiy-ostatka tiles, so
  // it's fetched once here. RBAC-scoped server-side.
  const discrepancies = useApiQuery<DiscrepanciesResponse>('/api/discrepancies');
  const aging = useApiQuery<AgingAlertsResponse>('/api/dashboard/aging-alerts');
  // May 404 until the parallel agent lands the endpoint — handled gracefully.
  const brak = useApiQuery<BrakSummary>(
    `/api/dashboard/brak-summary?${rangeQuery}`,
  );

  const wrongKeyed = discrepancies.data?.summary.wrong_keyed ?? 0;
  const negativeStock = discrepancies.data?.summary.negative_stock ?? 0;

  const agingCounts = useMemo(() => {
    const items = aging.data?.items ?? [];
    let critical = 0;
    let warning = 0;
    for (const it of items) {
      if (it.urgency === 'critical') critical += 1;
      else warning += 1;
    }
    return { total: items.length, critical, warning };
  }, [aging.data]);

  const discrepanciesLoading =
    discrepancies.isLoading && discrepancies.data === null;
  const agingLoading = aging.isLoading && aging.data === null;
  // Brak: a genuine in-flight load shows a skeleton; an error / 404 shows "—".
  const brakLoading = brak.isLoading && brak.data === null && brak.error === null;
  const brakMissing = brak.error !== null || brak.data === null;

  const brakValue = brakMissing
    ? '—'
    : `${(Math.round((brak.data?.brak_ratio ?? 0) * 1000) / 10).toLocaleString(
        'uz-UZ',
      )}%`;
  const brakCaption = brakMissing
    ? "ma'lumot yo'q"
    : `${formatPlainNumber(brak.data?.total_brak_qty ?? 0)} dona brak`;
  const brakTone: Tone = brakMissing
    ? 'default'
    : (brak.data?.brak_ratio ?? 0) >= 0.05
      ? 'danger'
      : (brak.data?.brak_ratio ?? 0) > 0
        ? 'warning'
        : 'default';

  const tiles: QualityTile[] = [
    {
      testId: 'quality-wrong-keyed',
      label: 'Kassa tafovuti',
      value: formatQty(wrongKeyed),
      caption: wrongKeyed > 0 ? 'ortiqcha sotuv' : 'tafovut yo‘q',
      tone: wrongKeyed > 0 ? 'danger' : 'default',
      Icon: Receipt,
      href: '/cashier/discrepancies',
      loading: discrepanciesLoading,
    },
    {
      testId: 'quality-negative-stock',
      label: 'Manfiy ostatka',
      value: formatQty(negativeStock),
      caption: negativeStock > 0 ? 'pozitsiya' : 'hammasi joyida',
      tone: negativeStock > 0 ? 'danger' : 'default',
      Icon: PackageX,
      href: '/cashier/discrepancies',
      loading: discrepanciesLoading,
    },
    {
      testId: 'quality-aging',
      label: "Muddati o'tayotgan",
      value: formatQty(agingCounts.total),
      caption:
        agingCounts.total === 0
          ? 'muddat xavfi yo‘q'
          : agingCounts.critical > 0
            ? `${formatQty(agingCounts.critical)} kritik · ${formatQty(
                agingCounts.warning,
              )} ogoh`
            : `${formatQty(agingCounts.warning)} ogohlantirish`,
      tone:
        agingCounts.critical > 0
          ? 'danger'
          : agingCounts.warning > 0
            ? 'warning'
            : 'default',
      Icon: CalendarClock,
      loading: agingLoading,
    },
    {
      testId: 'quality-brak',
      label: 'Brak %',
      value: brakValue,
      caption: brakCaption,
      tone: brakTone,
      Icon: AlertOctagon,
      loading: brakLoading,
    },
  ];

  return (
    <section className={cn('space-y-3', className)} aria-label="Sifat va integritet">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Sifat &amp; integritet
      </h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((tile) => (
          <QualityTileCard key={tile.testId} tile={tile} />
        ))}
      </div>
    </section>
  );
}

function QualityTileCard({ tile }: { tile: QualityTile }) {
  const { Icon } = tile;

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-xs">
          {tile.label}
        </p>
        <Icon
          aria-hidden="true"
          className={cn('size-5 shrink-0 sm:size-6', ICON_TONE[tile.tone])}
        />
      </div>
      {tile.loading ? (
        <div className="flex flex-col gap-2" aria-hidden="true">
          <div className="h-8 w-16 animate-pulse rounded bg-foreground/10 sm:h-9" />
          <div className="h-3 w-20 animate-pulse rounded bg-foreground/10" />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <span
            className={cn(
              'text-3xl font-bold leading-none tabular-nums sm:text-4xl',
              VALUE_TONE[tile.tone],
            )}
            data-testid={`${tile.testId}-value`}
          >
            {tile.value}
          </span>
          <span className="text-xs text-muted-foreground">{tile.caption}</span>
        </div>
      )}
    </>
  );

  const surfaceClass =
    'flex min-h-[120px] flex-col justify-between gap-3 border-border/60 p-4 sm:p-5';

  if (tile.href !== undefined) {
    return (
      <Link
        to={tile.href}
        data-testid={tile.testId}
        data-tone={tile.tone}
        aria-label={`${tile.label} — batafsil`}
        className={cn(
          'group rounded-lg border bg-card text-card-foreground shadow-sm transition-colors hover:border-border',
          surfaceClass,
          'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
      >
        {body}
      </Link>
    );
  }

  return (
    <Card
      data-testid={tile.testId}
      data-tone={tile.tone}
      role="region"
      aria-label={tile.label}
      className={surfaceClass}
    >
      {body}
    </Card>
  );
}
