import { cn } from '@/lib/utils';

/**
 * Dashboard v3 — Canvas view toggle.
 *
 * Pill segment control with two tabs: Calm (default — 5-node compressed
 * canvas) and Detalli (full ecosystem ~15 nodes). The parent owns the
 * state and persists it to `localStorage` so the choice survives a
 * reload.
 *
 * Accessibility: WAI-ARIA tablist pattern. Native button focus ring is
 * kept; arrow-key navigation is intentionally not wired up — the
 * control is only 2 wide and click + keyboard activation cover both
 * pointer and AT users.
 */
export type CanvasView = 'calm' | 'detail';

export interface CanvasTabsProps {
  view: CanvasView;
  onChange: (next: CanvasView) => void;
  className?: string;
}

interface TabSpec {
  value: CanvasView;
  label: string;
}

const TABS: readonly TabSpec[] = [
  { value: 'calm', label: 'Calm' },
  { value: 'detail', label: 'Detalli' },
] as const;

export function CanvasTabs({ view, onChange, className }: CanvasTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Canvas ko'rinish rejimi"
      data-testid="canvas-tabs"
      className={cn(
        'inline-flex w-[200px] items-center gap-1 rounded-full border border-border/60 bg-card p-1',
        className,
      )}
    >
      {TABS.map((tab) => {
        const active = tab.value === view;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`canvas-tab-${tab.value}`}
            data-state={active ? 'active' : 'inactive'}
            onClick={() => {
              if (!active) onChange(tab.value);
            }}
            className={cn(
              'flex-1 h-8 inline-flex items-center justify-center rounded-full px-3 text-xs font-semibold tracking-tight transition-colors outline-none',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              active
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
