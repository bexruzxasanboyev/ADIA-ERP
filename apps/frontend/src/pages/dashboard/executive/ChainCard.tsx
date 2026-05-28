import type { ComponentType, CSSProperties, KeyboardEvent } from 'react';
import { Box, ChevronRight, Factory, Store, Truck, Warehouse } from 'lucide-react';
import { MicroSparkline } from '@/components/charts/MicroSparkline';
import { CHAIN_LABELS, type ChainTone } from '@/lib/chainTokens';
import type { LocationType } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Sprint B — ChainCard.
 *
 * Compact dense card for one chain layer. Header (title + count + icon) +
 * 2×2 stat grid (4 metrics) + "Batafsil →" footer. Click opens the
 * detail drawer (Sprint C).
 *
 * Visual spec: `docs/design/dashboard-redesign-plan.md` §2 / §4.1 +
 * owner sketch (2026-05-25): metrics shown directly inside the card.
 */
export type ChainStatTone = 'default' | 'danger' | 'warn' | 'success';

export interface ChainStat {
  label: string;
  value: string;
  tone?: ChainStatTone;
  /** Optional caption rendered below the value (e.g. unit, secondary number). */
  caption?: string;
}

export interface ChainCardSummary {
  /** "1 bo'g'in", "4 sex", "26 blok", "6 do'kon". */
  countLabel: string;
  /** Overall status of this stage — drives the corner dot. */
  status: 'ok' | 'warn' | 'danger';
  /** Metrics shown in a 2-column grid (any length — most chains use 4-6). */
  stats: ChainStat[];
}

export interface ChainCardProps {
  type: LocationType;
  tone: ChainTone;
  title: string;
  summary: ChainCardSummary;
  selected: boolean;
  onSelect(): void;
  /**
   * Variant C — compact pipeline mode. Renders a smaller card with the top
   * 2 stats and a 7-day sparkline beneath them. Used inside `ChainPipeline`.
   */
  compact?: boolean;
  /** Optional 7-day trend used when `compact` is true. */
  sparkline?: number[];
}

const TYPE_ICON: Record<LocationType, ComponentType<{ className?: string }>> = {
  raw_warehouse: Box,
  production: Factory,
  supply: Truck,
  sex_storage: Truck,
  central_warehouse: Warehouse,
  store: Store,
};

const TONE_CLASSES: Record<
  ChainTone,
  {
    text: string;
    bgTint: string;
    borderHover: string;
    borderSelected: string;
    glowVar: string;
  }
> = {
  raw: {
    text: 'text-chain-raw',
    bgTint: 'bg-chain-raw-tint',
    borderHover: 'hover:border-chain-raw/50',
    borderSelected: 'border-chain-raw/70',
    glowVar: '--chain-raw-glow',
  },
  production: {
    text: 'text-chain-production',
    bgTint: 'bg-chain-production-tint',
    borderHover: 'hover:border-chain-production/50',
    borderSelected: 'border-chain-production/70',
    glowVar: '--chain-production-glow',
  },
  supply: {
    text: 'text-chain-supply',
    bgTint: 'bg-chain-supply-tint',
    borderHover: 'hover:border-chain-supply/50',
    borderSelected: 'border-chain-supply/70',
    glowVar: '--chain-supply-glow',
  },
  // `sex_storage` mirrors the supply tone — see chainTokens.ts.
  sex_storage: {
    text: 'text-chain-supply',
    bgTint: 'bg-chain-supply-tint',
    borderHover: 'hover:border-chain-supply/50',
    borderSelected: 'border-chain-supply/70',
    glowVar: '--chain-supply-glow',
  },
  central: {
    text: 'text-chain-central',
    bgTint: 'bg-chain-central-tint',
    borderHover: 'hover:border-chain-central/50',
    borderSelected: 'border-chain-central/70',
    glowVar: '--chain-central-glow',
  },
  store: {
    text: 'text-chain-store',
    bgTint: 'bg-chain-store-tint',
    borderHover: 'hover:border-chain-store/50',
    borderSelected: 'border-chain-store/70',
    glowVar: '--chain-store-glow',
  },
};

const STAT_TONE_CLASSES: Record<ChainStatTone, string> = {
  default: 'text-foreground',
  danger: 'text-destructive',
  warn: 'text-warning',
  success: 'text-success',
};

const STATUS_DOT: Record<ChainCardSummary['status'], string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  danger: 'bg-destructive',
};

export function ChainCard({
  type,
  tone,
  title,
  summary,
  selected,
  onSelect,
  compact = false,
  sparkline,
}: ChainCardProps) {
  const Icon = TYPE_ICON[type];
  const toneCx = TONE_CLASSES[tone];

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  };

  const style: CSSProperties = {
    backgroundImage: `radial-gradient(at 90% 0%, hsl(var(${toneCx.glowVar})) 0%, transparent 65%)`,
  };

  if (compact) {
    // Variant C — compact mode for `ChainPipeline`.
    // Smaller footprint, 2 hero stats + a 7-day sparkline.
    const compactStats = summary.stats.slice(0, 2);
    return (
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={`${title} bo'limini ochish`}
        data-testid={`chain-card-${type}`}
        data-selected={selected ? 'true' : 'false'}
        data-tone={tone}
        data-compact="true"
        onClick={onSelect}
        onKeyDown={handleKeyDown}
        style={style}
        className={cn(
          'group relative flex cursor-pointer flex-col gap-2.5 rounded-xl border bg-card p-3.5 outline-none transition-all duration-150',
          'hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          selected
            ? cn('border-2', toneCx.borderSelected, 'shadow-md')
            : cn('border-border', toneCx.borderHover),
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              data-testid={`chain-card-status-${type}`}
              className={cn(
                'inline-block size-2.5 shrink-0 rounded-full',
                STATUS_DOT[summary.status],
              )}
            />
            <p
              className={cn(
                'truncate text-sm font-semibold tracking-tight',
                toneCx.text,
              )}
            >
              {title}
            </p>
          </div>
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex size-7 shrink-0 items-center justify-center rounded-md',
              toneCx.bgTint,
              toneCx.text,
            )}
          >
            <Icon className="size-3.5" />
          </span>
        </div>

        <p className="-mt-1 truncate text-[11px] text-muted-foreground">
          {summary.countLabel}
        </p>

        {compactStats.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {compactStats.map((stat, i) => (
              <CompactStatCell key={i} stat={stat} />
            ))}
          </div>
        )}

        {sparkline && sparkline.length >= 2 && (
          <div className="mt-auto" aria-hidden="true">
            <MicroSparkline
              values={sparkline}
              tone={tone}
              height={24}
              width={140}
              className="w-full"
              ariaLabel={`${title} — 7 kunlik trend`}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${title} bo'limini ochish`}
      data-testid={`chain-card-${type}`}
      data-selected={selected ? 'true' : 'false'}
      data-tone={tone}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      style={style}
      className={cn(
        'group relative flex cursor-pointer flex-col gap-4 rounded-xl border bg-card p-5 outline-none transition-all duration-150',
        'hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        selected
          ? cn('border-2', toneCx.borderSelected, 'shadow-lg')
          : cn('border-border', toneCx.borderHover),
      )}
    >
      {/* Header — title + count + icon */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              data-testid={`chain-card-status-${type}`}
              className={cn(
                'inline-block size-2.5 shrink-0 rounded-full',
                STATUS_DOT[summary.status],
              )}
            />
            <p
              className={cn(
                'truncate text-2xl font-bold tracking-tight',
                toneCx.text,
              )}
            >
              {title}
            </p>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {summary.countLabel}
          </p>
        </div>
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex size-12 shrink-0 items-center justify-center rounded-lg',
            toneCx.bgTint,
            toneCx.text,
          )}
        >
          <Icon className="size-6" />
        </span>
      </div>

      {/* 2×2 metric grid */}
      <div className="grid grid-cols-2 gap-3">
        {summary.stats.map((stat, i) => (
          <StatCell key={i} stat={stat} />
        ))}
      </div>

      {/* Footer — Batafsil button */}
      <div
        className={cn(
          'mt-auto -mb-1 -mr-1 ml-auto flex items-center gap-1 self-end rounded-md px-2 py-1 text-xs font-semibold transition-colors',
          toneCx.text,
          'opacity-70 group-hover:opacity-100',
        )}
        aria-hidden="true"
      >
        Batafsil <ChevronRight className="size-3.5" />
      </div>
    </div>
  );
}

function CompactStatCell({ stat }: { stat: ChainStat }) {
  const toneClass = STAT_TONE_CLASSES[stat.tone ?? 'default'];
  return (
    <div className="rounded-md border border-border/30 bg-surface-2/30 px-2 py-1.5">
      <p className="truncate text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        {stat.label}
      </p>
      <p
        className={cn(
          'truncate text-base font-bold leading-tight tabular-nums',
          toneClass,
        )}
      >
        {stat.value}
      </p>
    </div>
  );
}

function StatCell({ stat }: { stat: ChainStat }) {
  const toneClass = STAT_TONE_CLASSES[stat.tone ?? 'default'];
  return (
    <div className="rounded-lg border border-border/30 bg-surface-2/30 px-3.5 py-2.5">
      <p className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {stat.label}
      </p>
      <p
        className={cn(
          'mt-0.5 truncate text-2xl font-bold leading-tight tabular-nums',
          toneClass,
        )}
      >
        {stat.value}
      </p>
      {stat.caption && (
        <p className="truncate text-[10px] text-muted-foreground tabular-nums">
          {stat.caption}
        </p>
      )}
    </div>
  );
}

export { CHAIN_LABELS };
