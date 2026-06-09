import { type ComponentType, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  Box,
  Factory,
  Store,
  Truck,
  Warehouse,
} from 'lucide-react';
import { CHAIN_LABELS, CHAIN_TONE_BY_TYPE } from '@/lib/chainTokens';
import { formatCurrencyCompact, formatQty, formatRelative } from '@/lib/format';
import type {
  ChainPulse,
  ChainStatus,
  ChainSummaryNode,
  LocationType,
} from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * ZANJIR SALOMATLIGI — the whole supply chain at a glance.
 *
 * Five compact, ordered status cards — one per stage
 * (Xom-ashyo → Sexlar → Ta'minot → Markaziy → Do'kon). Each card
 * aggregates *all* locations of its type, so adding a 30th store never
 * reshapes the layout. Owner-approved Command Center layout (2026-06).
 *
 * Every card surfaces:
 *   • a status dot (ok / warn / danger) + chain-tone title + icon
 *   • "Min'dan past: N" — the action signal
 *   • a per-stage "today" pulse line (received / produced / shipped / sync /
 *     sales) so the boshliq sees momentum, not just inventory
 *
 * The whole card is a `<Link>` to that stage's workspace route, so one
 * click drills the owner straight into the section that needs them.
 */
export interface ChainHealthRowProps {
  chainSummary: ChainSummaryNode[];
  className?: string;
}

const STAGE_ORDER: readonly LocationType[] = [
  'raw_warehouse',
  'production',
  'supply',
  'central_warehouse',
  'store',
] as const;

const TYPE_ICON: Record<LocationType, ComponentType<{ className?: string }>> = {
  raw_warehouse: Box,
  production: Factory,
  supply: Truck,
  sex_storage: Truck,
  central_warehouse: Warehouse,
  store: Store,
};

/** Stage workspace routes (see routes/AppRouter.tsx). */
const TYPE_ROUTE: Record<LocationType, string> = {
  raw_warehouse: '/raw-warehouse',
  production: '/production',
  supply: '/supply',
  sex_storage: '/supply',
  central_warehouse: '/central-workflow',
  store: '/store-workflow',
};

const STATUS_DOT: Record<ChainStatus, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  danger: 'bg-destructive',
};

const STATUS_LABEL: Record<ChainStatus, string> = {
  ok: 'Normal',
  warn: 'Diqqat',
  danger: 'Kritik',
};

const TONE_TEXT: Record<string, string> = {
  raw: 'text-chain-raw',
  production: 'text-chain-production',
  supply: 'text-chain-supply',
  sex_storage: 'text-chain-supply',
  central: 'text-chain-central',
  store: 'text-chain-store',
};

/** Left accent bar tone — a thin chain-coloured rail down the card edge. */
const TONE_ACCENT: Record<string, string> = {
  raw: 'bg-chain-raw',
  production: 'bg-chain-production',
  supply: 'bg-chain-supply',
  sex_storage: 'bg-chain-supply',
  central: 'bg-chain-central',
  store: 'bg-chain-store',
};

const TONE_HOVER_BORDER: Record<string, string> = {
  raw: 'hover:border-chain-raw/60',
  production: 'hover:border-chain-production/60',
  supply: 'hover:border-chain-supply/60',
  sex_storage: 'hover:border-chain-supply/60',
  central: 'hover:border-chain-central/60',
  store: 'hover:border-chain-store/60',
};

export function ChainHealthRow({ chainSummary, className }: ChainHealthRowProps) {
  const byType = useMemo(() => {
    const map = new Map<LocationType, ChainSummaryNode>();
    for (const row of chainSummary) map.set(row.type, row);
    return map;
  }, [chainSummary]);

  return (
    <section
      data-testid="chain-health-row"
      aria-label="Zanjir salomatligi"
      className={cn('space-y-3', className)}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Zanjir salomatligi
        </h2>
        <p className="hidden text-xs text-muted-foreground sm:block">
          5 bo&apos;g&apos;in · har biri bir bosishda batafsil
        </p>
      </div>
      <ol className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {STAGE_ORDER.map((type) => (
          <li key={type}>
            <ChainHealthCard type={type} summary={byType.get(type) ?? null} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function ChainHealthCard({
  type,
  summary,
}: {
  type: LocationType;
  summary: ChainSummaryNode | null;
}) {
  const tone = CHAIN_TONE_BY_TYPE[type];
  const Icon = TYPE_ICON[type];
  const status: ChainStatus = summary?.status ?? 'ok';
  const belowMin = summary?.below_min_count ?? 0;
  const pulse = pulseLine(summary);

  return (
    <Link
      to={TYPE_ROUTE[type]}
      data-testid={`chain-node-${type}`}
      data-status={status}
      aria-label={`${CHAIN_LABELS[tone]} — ${STATUS_LABEL[status]}, batafsil ochish`}
      className={cn(
        'group relative flex h-full flex-col gap-3 overflow-hidden rounded-xl border border-border/70 bg-card text-card-foreground shadow-card p-4 pl-5 transition-[border-color,box-shadow] hover:shadow-card-hover',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        TONE_HOVER_BORDER[tone],
      )}
    >
      {/* Chain-tone accent rail down the left edge. */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-y-0 left-0 w-1',
          TONE_ACCENT[tone],
        )}
      />

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            data-testid={`chain-node-status-${type}`}
            className={cn(
              'inline-block size-2.5 shrink-0 rounded-full',
              STATUS_DOT[status],
            )}
          />
          <p
            className={cn(
              'truncate text-sm font-semibold tracking-tight',
              TONE_TEXT[tone],
            )}
          >
            {CHAIN_LABELS[tone]}
          </p>
        </div>
        <Icon
          aria-hidden="true"
          className={cn('size-4 shrink-0', TONE_TEXT[tone])}
        />
      </div>

      {/* Below-min — the action signal, sized like a small KPI. */}
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'text-2xl font-semibold tabular-nums tracking-tight',
            belowMin > 0 ? 'text-destructive' : 'text-foreground',
          )}
        >
          {formatQty(belowMin)}
        </span>
        <span className="text-xs text-muted-foreground">min&apos;dan past</span>
      </div>

      {/* Today-pulse line — per-stage momentum. */}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/40 pt-2.5">
        <p className="min-w-0 truncate text-[11px] text-muted-foreground">
          {pulse}
        </p>
        <ArrowUpRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
        />
      </div>
    </Link>
  );
}

/**
 * One-line "today" pulse per stage, derived from the discriminated
 * `ChainPulse`. Kept terse so it never wraps inside the card footer.
 */
function pulseLine(node: ChainSummaryNode | null): string {
  if (node === null) return "Ma'lumot yo'q";
  const pulse: ChainPulse = node.pulse;
  switch (pulse.kind) {
    case 'raw':
      return `Bugun qabul: ${formatQty(pulse.received_today)} · chiqim: ${formatQty(
        pulse.issued_today,
      )}`;
    case 'production':
      return `Faol zayafka: ${formatQty(pulse.active_orders)} · bajarildi: ${formatQty(
        pulse.done_today,
      )}`;
    case 'supply':
      return `Bugun jo'natildi: ${formatQty(pulse.shipped_today)} · qabul: ${formatQty(
        pulse.received_today,
      )}`;
    case 'central': {
      const errors = pulse.sync_errors_24h ?? 0;
      if (errors > 0) return `Sinx xato (24h): ${formatQty(errors)}`;
      if (pulse.last_sync_status === 'failed') return 'Sinx: xatolik';
      if (pulse.last_sync_at === null) return 'Sinx: hali yo‘q';
      return `Sinx: ${formatRelative(pulse.last_sync_at)}`;
    }
    case 'store':
      return `Bugun savdo: ${formatCurrencyCompact(
        pulse.sales_today_sum,
      )} · ${formatQty(pulse.receipts_today)} chek`;
  }
}
