import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/PageState';
import { ForecastsPanel } from '../ForecastsPanel';
import { OpenRequestsChart } from '../OpenRequestsChart';
import { RequestsTrendChart } from './RequestsTrendChart';
import type { DashboardOverview, ReplenishmentStatus } from '@/lib/types';
import type { DateRangeValue } from '@/components/DateRangeFilter';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

/**
 * F4.7 — Below-the-fold detail row for the executive dashboard.
 *
 * Layout (owner request, 2026-06):
 *   - Requests trend chart (so'rovlar dinamikasi — accepted/shipped, with a
 *     department select), replacing the old plan table, full width.
 *   - Bashorat (forecasts) + Ochiq so'rovlar status — side by side (2-up),
 *     stacking on narrow viewports.
 *
 * The requests chart and the open-requests donut follow the dashboard
 * date-range filter via `range`.
 */
export function DashboardSecondaryRow({
  overview,
  range,
}: {
  overview: DashboardOverview;
  range: DateRangeValue;
}) {
  return (
    <div className="space-y-6">
      <RequestsTrendChart range={range} />

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-2">
        <ForecastsPanel />
        <OpenRequestsPanel overview={overview} />
      </div>
    </div>
  );
}

function OpenRequestsPanel({ overview }: { overview: DashboardOverview }) {
  const entries = Object.entries(overview.open_requests.by_status) as [
    ReplenishmentStatus,
    number,
  ][];
  const total = overview.open_requests.total;
  return (
    <Card className="flex flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold">Ochiq so‘rovlar — status</h2>
          <p className="text-xs text-muted-foreground">
            Holat bo‘yicha guruhlangan ochiq to‘ldirish so‘rovlari.
          </p>
        </div>
        <Link
          to="/replenishment"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          So‘rovlar
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </header>
      <div className="flex flex-1 flex-col gap-4 p-5">
        {total === 0 ? (
          <EmptyState message="Ochiq so‘rovlar yo‘q." />
        ) : (
          <OpenRequestsChart entries={entries} total={total} />
        )}
      </div>
    </Card>
  );
}
