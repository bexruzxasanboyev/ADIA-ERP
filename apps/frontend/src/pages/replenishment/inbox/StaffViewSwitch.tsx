import { ClipboardList, Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Owner feedback (2026-06-10, dokonchi): "mahsulotlar tabi qani? o'zida bor
 * mahsulotlar qayerdan ko'rinib turadi?" — collapsing the staff tabs behind
 * the tiny «Batafsil →» link HID the on-hand products view.
 *
 * <StaffViewSwitch> is the fix: a LARGE, impossible-to-miss segmented control
 * at the top of every frontline staff workspace (store / central / production /
 * raw warehouse) with exactly two first-class views:
 *
 *   - «Ishlarim»    — the three-group action feed (default), count badge live.
 *   - «Mahsulotlar» — the department's own on-hand stock list.
 *
 * History / power views stay behind the small «Batafsil» link INSIDE the
 * Ishlarim segment; products are never hidden again. PM/Admin never see this —
 * they keep the full tab row.
 */

export type StaffView = 'inbox' | 'products';

const SEGMENTS: {
  value: StaffView;
  label: string;
  icon: typeof ClipboardList;
}[] = [
  { value: 'inbox', label: 'Ishlarim', icon: ClipboardList },
  { value: 'products', label: 'Mahsulotlar', icon: Package },
];

export function StaffViewSwitch({
  value,
  onChange,
  inboxCount,
  className,
}: {
  value: StaffView;
  onChange: (view: StaffView) => void;
  /** Actionable-work count shown as a live badge on the «Ishlarim» segment. */
  inboxCount: number;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Ish maydoni ko‘rinishi"
      className={cn(
        'mx-auto grid w-full max-w-2xl grid-cols-2 gap-1 rounded-xl border border-border/70 bg-surface-1 p-1',
        className,
      )}
    >
      {SEGMENTS.map((seg) => {
        const isActive = seg.value === value;
        const Icon = seg.icon;
        return (
          <button
            key={seg.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(seg.value)}
            className={cn(
              // Large touch target (≥ 48px) — frontline staff, often on touch.
              'flex min-h-12 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors sm:text-base',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/25'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            {seg.label}
            {seg.value === 'inbox' && (
              <Badge
                variant={inboxCount > 0 ? 'warning' : 'secondary'}
                className="tabular-nums"
                aria-label={`${inboxCount} ta kutilayotgan ish`}
              >
                {inboxCount}
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}
