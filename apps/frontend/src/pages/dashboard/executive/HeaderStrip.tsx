import { useEffect, useState, type ReactNode } from 'react';
import { formatDateLong, getGreeting } from '@/lib/format';

function useClock(): string {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now.toLocaleTimeString('uz-UZ', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

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
  const clock = useClock();

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
        <p className="hidden items-center gap-2 text-sm text-muted-foreground tabular-nums sm:flex">
          <span>{longDate}</span>
          <span aria-hidden="true" className="text-border">·</span>
          <span className="font-medium text-foreground" data-testid="executive-header-clock">{clock}</span>
        </p>
      </div>
    </header>
  );
}
