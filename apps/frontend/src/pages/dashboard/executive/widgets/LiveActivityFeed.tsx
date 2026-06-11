import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type {
  DashboardRecentMovementItem,
  MovementReason,
} from '@/lib/types';
import { formatQty, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Variant C — live activity feed.
 *
 * Renders the last 8 movements from `DashboardOverview.recent_movements`.
 * Each row carries a reason badge coloured to its chain tone (purchase→
 * raw, production_output→production, transfer→supply, sale→store).
 * Scroll-locked card body so the page height stays predictable.
 */
const REASON_LABEL: Record<MovementReason, string> = {
  sale: 'Sotuv',
  purchase: 'Sotib olish',
  production_input: 'Sex kirimi',
  production_output: 'Sex chiqimi',
  transfer: "Jo'natma",
  adjust: "Tuzatish",
};

const REASON_BADGE: Record<
  MovementReason,
  { className: string; tone: string }
> = {
  sale: { className: 'bg-chain-store/15 text-chain-store', tone: 'store' },
  purchase: { className: 'bg-chain-raw/15 text-chain-raw', tone: 'raw' },
  production_input: {
    className: 'bg-chain-production/15 text-chain-production',
    tone: 'production',
  },
  production_output: {
    className: 'bg-chain-production/15 text-chain-production',
    tone: 'production',
  },
  transfer: {
    className: 'bg-chain-supply/15 text-chain-supply',
    tone: 'supply',
  },
  adjust: {
    className: 'bg-muted text-muted-foreground',
    tone: 'neutral',
  },
};

export interface LiveActivityFeedProps {
  items: DashboardRecentMovementItem[];
  /** Cap the visible feed; default = 8. */
  maxItems?: number;
}

export function LiveActivityFeed({
  items,
  maxItems = 8,
}: LiveActivityFeedProps) {
  const visible = items.slice(0, maxItems);

  return (
    <Card
      className="flex flex-col gap-2 p-4"
      role="region"
      aria-labelledby="live-activity-title"
      data-testid="live-activity-feed"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2
          id="live-activity-title"
          className="text-sm font-semibold text-foreground"
        >
          Bugungi harakatlar
        </h2>
        <Link
          to="/movements"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Hammasini ko'rish
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </header>

      {visible.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Bugun harakat yo'q.
        </p>
      ) : (
        <ul
          className="flex max-h-60 flex-col gap-1 overflow-y-auto pr-1"
          data-testid="live-activity-list"
        >
          {visible.map((row) => (
            <li
              key={row.id}
              className="flex items-start gap-2 rounded-md border border-border/30 bg-surface-2/40 px-2.5 py-1.5"
            >
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {formatRelative(row.created_at)}
              </span>
              <Badge
                variant="outline"
                className={cn(
                  'shrink-0 border-transparent px-1.5 py-0 text-[10px]',
                  REASON_BADGE[row.reason].className,
                )}
              >
                {REASON_LABEL[row.reason]}
              </Badge>
              <p className="min-w-0 flex-1 truncate text-xs text-foreground">
                <span className="font-medium">{row.product_name}</span>
                <span className="text-muted-foreground">
                  {' · '}
                  {row.from_location_name ?? '—'}
                  {' → '}
                  {row.to_location_name ?? '—'}
                </span>
              </p>
              <span className="shrink-0 text-[11px] font-medium tabular-nums text-foreground">
                {formatQty(row.qty)} {row.product_unit}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
