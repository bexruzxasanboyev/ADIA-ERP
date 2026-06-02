import {
  type ComponentType,
  type KeyboardEvent,
  useMemo,
} from 'react';
import { Box, Factory, Store, Truck, Warehouse } from 'lucide-react';
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
 * ChainHealthRow — insight-first replacement for the React-Flow ecosystem
 * canvas (dashboard redesign 2026-05).
 *
 * The old node-graph degraded as locations multiplied: edges crossed,
 * nodes overlapped, nothing scanned cleanly. This row collapses the
 * whole supply chain into FIVE compact, ordered status cards — one per
 * stage (Xom-ashyo → Ishlab chiqarish → Ishlab chiqarish ombori → Markaziy → Do'kon).
 * It scales: each card aggregates *all* locations of its type, so adding
 * a 30th store never reshapes the layout.
 *
 * Each card surfaces, at a glance:
 *   • a status dot (ok / warn / danger) + chain-tone title + icon
 *   • below-min count and open-request count (the action signals)
 *   • a per-stage "today" pulse line (sales, production, sync, …)
 *
 * The card is a real button: keyboard-focusable, `aria-pressed`, and
 * clicking opens the per-stage detail drawer via `onSelect`.
 */
export interface ChainHealthRowProps {
  chainSummary: ChainSummaryNode[];
  selectedChain: LocationType | null;
  onSelectChain: (type: LocationType | null) => void;
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

const TONE_BORDER: Record<string, string> = {
  raw: 'border-chain-raw',
  production: 'border-chain-production',
  supply: 'border-chain-supply',
  sex_storage: 'border-chain-supply',
  central: 'border-chain-central',
  store: 'border-chain-store',
};

export function ChainHealthRow({
  chainSummary,
  selectedChain,
  onSelectChain,
  className,
}: ChainHealthRowProps) {
  const byType = useMemo(() => {
    const map = new Map<LocationType, ChainSummaryNode>();
    for (const row of chainSummary) map.set(row.type, row);
    return map;
  }, [chainSummary]);

  return (
    <section
      data-testid="chain-health-row"
      aria-label="Zanjir salomatligi"
      className={cn('rounded-xl border border-border/60 bg-card', className)}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-2.5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Zanjir salomatligi
        </h2>
        <p className="hidden text-xs text-muted-foreground sm:block">
          {STAGE_ORDER.length} bo'g'in · har biri bir bosishda batafsil
        </p>
      </header>
      <ol className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {STAGE_ORDER.map((type) => (
          <li key={type}>
            <ChainHealthCard
              type={type}
              summary={byType.get(type) ?? null}
              selected={selectedChain === type}
              onSelect={onSelectChain}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function ChainHealthCard({
  type,
  summary,
  selected,
  onSelect,
}: {
  type: LocationType;
  summary: ChainSummaryNode | null;
  selected: boolean;
  onSelect: (type: LocationType | null) => void;
}) {
  const tone = CHAIN_TONE_BY_TYPE[type];
  const Icon = TYPE_ICON[type];
  const status: ChainStatus = summary?.status ?? 'ok';
  const stats = buildStats(summary);

  const handleClick = () => onSelect(selected ? null : type);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(selected ? null : type);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${CHAIN_LABELS[tone]} — ${STATUS_LABEL[status]}, batafsil ochish`}
      data-testid={`chain-node-${type}`}
      data-status={status}
      data-selected={selected ? 'true' : 'false'}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex h-full cursor-pointer flex-col gap-3 rounded-lg border bg-surface-2/30 p-3.5 outline-none transition-colors',
        'hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        selected
          ? cn('border-2', TONE_BORDER[tone])
          : 'border-border/50 hover:border-border',
      )}
    >
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
        <Icon aria-hidden="true" className={cn('size-4 shrink-0', TONE_TEXT[tone])} />
      </div>

      <p className="text-[11px] text-muted-foreground">
        {summary === null
          ? "Ma'lumot yo'q"
          : `${formatQty(summary.location_count)} ta bo'g'in`}
      </p>

      <dl className="grid grid-cols-2 gap-1.5">
        {stats.slice(0, 4).map((stat, i) => (
          <div
            key={i}
            className="flex flex-col rounded-md border border-border/30 bg-background/40 px-2 py-1.5"
          >
            <dt className="truncate text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
              {stat.label}
            </dt>
            <dd
              className={cn(
                'truncate text-sm font-bold leading-tight tabular-nums',
                STAT_TONE[stat.tone ?? 'default'],
              )}
            >
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const STAT_TONE: Record<'default' | 'danger' | 'warning', string> = {
  default: 'text-foreground',
  danger: 'text-destructive',
  warning: 'text-warning',
};

interface ChainStat {
  label: string;
  value: string;
  tone?: 'default' | 'danger' | 'warning';
}

/**
 * Map a chain-summary row to four scannable KPIs, tuned per stage to the
 * question the owner actually asks of that layer. Ported verbatim from the
 * retired CanvasFlow so the drill-in numbers stay identical.
 */
function buildStats(node: ChainSummaryNode | null): ChainStat[] {
  if (node === null) {
    return [
      { label: "Bo'g'in", value: '—' },
      { label: "Ma'lumot", value: '—' },
      { label: 'Pulse', value: '—' },
      { label: 'Status', value: '—' },
    ];
  }

  const pulse: ChainPulse = node.pulse;
  const belowMin: ChainStat = {
    label: "Min'dan past",
    value: formatQty(node.below_min_count),
    // Small alert counts stay 'warning'; only 4+ bumps to 'danger' so a
    // single low SKU does not paint the whole stage red.
    tone:
      node.below_min_count === 0
        ? 'default'
        : node.below_min_count >= 4
          ? 'danger'
          : 'warning',
  };
  const skuCount: ChainStat = {
    label: 'SKU',
    value: formatQty(node.total_products),
  };

  switch (pulse.kind) {
    case 'raw': {
      const pending = pulse.pending_purchase_orders ?? 0;
      return [
        skuCount,
        belowMin,
        { label: 'Bugun qabul', value: formatQty(pulse.received_today) },
        {
          label: 'Ochiq PO',
          value: formatQty(pending),
          tone: pending > 0 ? 'warning' : 'default',
        },
      ];
    }
    case 'production': {
      const overdue = pulse.overdue_orders ?? 0;
      return [
        { label: 'Faol zayafka', value: formatQty(pulse.active_orders) },
        { label: 'Bugun bajarildi', value: formatQty(pulse.done_today) },
        {
          label: "Muddat o'tgan",
          value: formatQty(overdue),
          tone:
            overdue === 0 ? 'default' : overdue >= 3 ? 'danger' : 'warning',
        },
        { label: 'Sex', value: formatQty(pulse.sex_count ?? 0) },
      ];
    }
    case 'supply': {
      const openReq = pulse.open_requests ?? 0;
      return [
        skuCount,
        {
          label: "Ochiq so'rov",
          value: formatQty(openReq),
          tone:
            openReq === 0 ? 'default' : openReq >= 5 ? 'danger' : 'warning',
        },
        { label: "Bugun jo'natildi", value: formatQty(pulse.shipped_today) },
        { label: 'Bugun qabul', value: formatQty(pulse.received_today) },
      ];
    }
    case 'central': {
      const errors = pulse.sync_errors_24h ?? 0;
      return [
        skuCount,
        belowMin,
        {
          label: 'Oxirgi sinx',
          value:
            pulse.last_sync_at === null
              ? '—'
              : formatRelative(pulse.last_sync_at),
          tone:
            pulse.last_sync_status === 'failed'
              ? 'danger'
              : pulse.last_sync_status === 'partial'
                ? 'warning'
                : 'default',
        },
        {
          label: '24h xato',
          value: formatQty(errors),
          tone:
            errors === 0 ? 'default' : errors >= 5 ? 'danger' : 'warning',
        },
      ];
    }
    case 'store': {
      return [
        {
          label: 'Bugungi savdo',
          value: formatCurrencyCompact(pulse.sales_today_sum ?? 0),
        },
        { label: 'Cheklar', value: formatQty(pulse.receipts_today ?? 0) },
        {
          label: "O'rt chek",
          value: formatCurrencyCompact(pulse.avg_receipt_today ?? 0),
        },
        belowMin,
      ];
    }
  }
}
