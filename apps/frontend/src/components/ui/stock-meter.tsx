import { cn } from '@/lib/utils';

export type StockTone = 'danger' | 'warning' | 'success' | 'neutral';

const TONE_FILL: Record<StockTone, string> = {
  danger: 'bg-destructive',
  warning: 'bg-warning',
  success: 'bg-success',
  neutral: 'bg-muted-foreground',
};

interface StockMeterProps {
  /** Current quantity as a fraction of max (0..1, clamped). */
  ratio: number;
  /** Min threshold as a fraction of max — rendered as a tick mark. */
  minRatio?: number;
  tone?: StockTone;
  className?: string;
}

/**
 * Slim stock-level meter: a rounded track filled to `ratio`, with an
 * optional tick at the min threshold. Replaces the old "red text + red
 * border" alarm styling — the status now reads from the fill colour
 * (danger/warning/success) while the card itself stays calm.
 */
export function StockMeter({
  ratio,
  minRatio,
  tone = 'neutral',
  className,
}: StockMeterProps) {
  const fill = Math.max(0, Math.min(1, ratio));
  const tick =
    minRatio === undefined ? undefined : Math.max(0, Math.min(1, minRatio));
  return (
    <div
      className={cn(
        'relative h-1.5 w-full overflow-hidden rounded-full bg-muted',
        className,
      )}
      aria-hidden="true"
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-300',
          TONE_FILL[tone],
        )}
        style={{ width: `${fill * 100}%` }}
      />
      {tick !== undefined && tick > 0 && tick < 1 && (
        <div
          className="absolute inset-y-0 w-px bg-foreground/40"
          style={{ left: `${tick * 100}%` }}
        />
      )}
    </div>
  );
}
