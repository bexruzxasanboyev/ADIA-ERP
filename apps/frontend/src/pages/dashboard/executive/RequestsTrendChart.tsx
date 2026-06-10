import { useMemo, useState } from 'react';
import { GitBranch as RequestsIcon } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/PageState';
import { Select } from '@/components/ui/select';
import {
  dateRangeToQuery,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatQty } from '@/lib/format';
import { chartBucketLabel } from '@/lib/chartTime';
import {
  CHART_ANIMATION_DURATION,
  CHART_ANIMATION_EASING,
} from '@/lib/chartAnimation';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import type { DashboardRequestsSeries, Location } from '@/lib/types';

// Owner-specified hues: "Qabul qilingan" (accepted) = yellow, "Jo'natilgan"
// (shipped) = green. "So'rov qilingan" (open — raised but not yet accepted)
// = blue. Literal HSL so they render in jsdom and the dark theme.
const ACCEPTED_COLOUR = 'hsl(45 93% 55%)'; // yellow
const SHIPPED_COLOUR = 'hsl(152 60% 48%)'; // green
const OPEN_COLOUR = 'hsl(204 90% 56%)'; // blue

interface RequestsDatum {
  label: string;
  accepted: number;
  shipped: number;
  open: number;
}

/**
 * So'rovlar dinamikasi — replenishment-request trend (owner request,
 * 2026-06). Replaces the production trend chart. Two lines per bucket:
 *   - Qabul qilingan (accepted — left NEW)        → yellow
 *   - Jo'natilgan   (shipped to requester)        → green
 *
 * Covers ALL departments' requests; a select narrows to one bo'lim (or
 * "Hammasi"). Follows the dashboard date-range filter: `range=today` →
 * hourly (`HH:00`), every other range → daily (`DD.MM`). Reads
 * `GET /api/dashboard/requests-series` and degrades gracefully (empty
 * state) on a missing/late endpoint.
 */
export function RequestsTrendChart({
  range,
  className,
}: {
  range: DateRangeValue;
  className?: string;
}) {
  // 'all' = every department the principal may see (no locationId param).
  const [locationId, setLocationId] = useState<string>('all');

  const locations = useApiQuery<Location[]>('/api/locations');
  const { data } = useApiQuery<DashboardRequestsSeries>(
    `/api/dashboard/requests-series?${dateRangeToQuery(range)}${
      locationId === 'all' ? '' : `&locationId=${locationId}`
    }`,
  );

  const granularity = data?.granularity ?? 'day';
  const periodLabel = granularity === 'hour' ? 'bugun' : 'tanlangan davr';

  const reducedMotion = usePrefersReducedMotion();

  const chartData = useMemo<RequestsDatum[]>(
    () =>
      (data?.days ?? []).map((p) => ({
        label: chartBucketLabel(p, granularity),
        accepted: p.accepted,
        shipped: p.shipped,
        open: p.open,
      })),
    [data, granularity],
  );

  const totals = useMemo(
    () =>
      (data?.days ?? []).reduce(
        (acc, p) => ({
          accepted: acc.accepted + p.accepted,
          shipped: acc.shipped + p.shipped,
          open: acc.open + p.open,
        }),
        { accepted: 0, shipped: 0, open: 0 },
      ),
    [data],
  );

  return (
    <div className={className}>
      <div className="mb-3 flex items-center justify-end gap-2">
        <label
          htmlFor="requests-series-location"
          className="text-xs font-medium text-muted-foreground"
        >
          Bo&apos;lim:
        </label>
        <Select
          id="requests-series-location"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          className="h-8 w-auto min-w-[12rem] text-xs"
          aria-label="So'rovlar bo'limi"
        >
          <option value="all">Hamma bo&apos;limlar</option>
          {(locations.data ?? []).map((loc) => (
            <option key={loc.id} value={String(loc.id)}>
              {loc.name}
            </option>
          ))}
        </Select>
      </div>

      <Card className="flex flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-5">
          <div className="space-y-0.5">
            <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <RequestsIcon
                className="size-4 text-primary"
                aria-hidden="true"
              />
              {`So'rovlar dinamikasi — ${periodLabel}`}
            </h2>
            <p className="text-xs text-muted-foreground">
              So&apos;rov qilingan, qabul qilingan va jo&apos;natilgan
              to&apos;ldirish so&apos;rovlari.
            </p>
          </div>
          <div className="flex shrink-0 gap-5 text-right">
            <LegendTotal
              colour={OPEN_COLOUR}
              label="So'rov qilingan"
              value={totals.open}
            />
            <LegendTotal
              colour={ACCEPTED_COLOUR}
              label="Qabul qilingan"
              value={totals.accepted}
            />
            <LegendTotal
              colour={SHIPPED_COLOUR}
              label="Jo'natilgan"
              value={totals.shipped}
            />
          </div>
        </header>

        <div className="p-5">
          {chartData.length === 0 ? (
            <EmptyState message="So'rov ma'lumotlari yo'q." />
          ) : (
            <div
              className="h-56 w-full"
              data-testid="requests-trend-chart"
              aria-label="So'rovlar dinamikasi"
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
                >
                  <CartesianGrid
                    stroke="hsl(var(--border))"
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={36}
                    allowDecimals={false}
                  />
                  <Tooltip
                    cursor={{ stroke: 'hsl(var(--border))' }}
                    content={renderRequestsTooltip}
                  />
                  <Line
                    type="monotone"
                    dataKey="open"
                    name="So'rov qilingan"
                    stroke={OPEN_COLOUR}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={!reducedMotion}
                    animationDuration={CHART_ANIMATION_DURATION}
                    animationEasing={CHART_ANIMATION_EASING}
                  />
                  <Line
                    type="monotone"
                    dataKey="accepted"
                    name="Qabul qilingan"
                    stroke={ACCEPTED_COLOUR}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={!reducedMotion}
                    animationDuration={CHART_ANIMATION_DURATION}
                    animationEasing={CHART_ANIMATION_EASING}
                  />
                  <Line
                    type="monotone"
                    dataKey="shipped"
                    name="Jo'natilgan"
                    stroke={SHIPPED_COLOUR}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={!reducedMotion}
                    animationDuration={CHART_ANIMATION_DURATION}
                    animationEasing={CHART_ANIMATION_EASING}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function LegendTotal({
  colour,
  label,
  value,
}: {
  colour: string;
  label: string;
  value: number;
}) {
  return (
    <div>
      <p className="flex items-center justify-end gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span
          aria-hidden="true"
          className="size-2.5 rounded-sm"
          style={{ background: colour }}
        />
        {label}
      </p>
      <p className="text-lg font-semibold tabular-nums leading-none">
        {formatQty(value)}
      </p>
    </div>
  );
}

function renderRequestsTooltip(props: TooltipProps<number, string>) {
  const { active, payload } = props;
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload as RequestsDatum | undefined;
  if (!point) return null;
  return (
    <div
      className="min-w-[11rem] rounded-lg border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-pop"
      data-testid="requests-tooltip"
    >
      <p className="mb-2 text-xs font-semibold tabular-nums text-foreground">
        {point.label}
      </p>
      <ul className="space-y-1.5 text-xs">
        <li className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full"
            style={{ background: OPEN_COLOUR }}
          />
          <span className="min-w-0 flex-1 text-muted-foreground">
            So&apos;rov qilingan
          </span>
          <span className="shrink-0 tabular-nums font-medium text-foreground">
            {formatQty(point.open)}
          </span>
        </li>
        <li className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full"
            style={{ background: ACCEPTED_COLOUR }}
          />
          <span className="min-w-0 flex-1 text-muted-foreground">
            Qabul qilingan
          </span>
          <span className="shrink-0 tabular-nums font-medium text-foreground">
            {formatQty(point.accepted)}
          </span>
        </li>
        <li className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full"
            style={{ background: SHIPPED_COLOUR }}
          />
          <span className="min-w-0 flex-1 text-muted-foreground">
            Jo&apos;natilgan
          </span>
          <span className="shrink-0 tabular-nums font-medium text-foreground">
            {formatQty(point.shipped)}
          </span>
        </li>
      </ul>
    </div>
  );
}
