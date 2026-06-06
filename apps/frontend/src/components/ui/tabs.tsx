import { cn } from '@/lib/utils';

/**
 * Minimal accessible tab strip. A roving `tablist` of buttons; the
 * caller renders panels conditionally based on the active value.
 */
interface TabsProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: { value: T; label: string }[];
  /** Accessible label for the tablist. */
  ariaLabel: string;
  /** When true the tabs stretch to fill the container width (equal columns). */
  fullWidth?: boolean;
  className?: string;
}

export function Tabs<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  fullWidth = false,
  className,
}: TabsProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'items-center gap-1 rounded-lg border border-border bg-card p-1',
        fullWidth ? 'flex w-full' : 'inline-flex',
        className,
      )}
    >
      {options.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onValueChange(opt.value)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              fullWidth && 'flex-1',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
