import type { ReactNode } from 'react';
import { formatDateLong, getGreeting } from '@/lib/format';

/**
 * F4.7 / F4.10 — Executive HeaderStrip.
 *
 * Top band of the boshliq dashboard:
 *   "Xayrli kun, Akmal Karimov" · [DateRangeFilter] · "24-may 2026, yakshanba"
 *
 * Greeting is derived from the local clock; the long date is rendered
 * from the supplied ISO string (kept overridable for deterministic
 * tests). `rangeFilter` (F4.10) slots a date-range control to the right
 * of the greeting on wide screens; on mobile it wraps to a new row.
 */
export function HeaderStrip({
  userName,
  isoDate,
  rangeFilter,
}: {
  userName: string;
  /** ISO `YYYY-MM-DD` or full timestamp. */
  isoDate: string;
  rangeFilter?: ReactNode;
}) {
  const greeting = getGreeting();
  const longDate = formatDateLong(isoDate);

  return (
    <header
      className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
      data-testid="executive-header-strip"
    >
      <h1 className="truncate text-lg font-medium text-foreground sm:text-xl">
        <span className="text-muted-foreground">{greeting},</span>{' '}
        <span className="font-semibold">{userName}</span>
      </h1>
      <div className="flex flex-wrap items-center gap-3">
        {rangeFilter}
        <p className="hidden text-sm text-muted-foreground tabular-nums sm:block">
          {longDate}
        </p>
      </div>
    </header>
  );
}
