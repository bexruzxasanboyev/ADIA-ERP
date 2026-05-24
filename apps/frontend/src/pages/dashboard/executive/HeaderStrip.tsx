import { formatDateLong, getGreeting } from '@/lib/format';

/**
 * F4.7 — Executive HeaderStrip (~56px).
 *
 * Top band of the boshliq dashboard:
 *   "Xayrli kun, Akmal Karimov" · "24-may 2026, yakshanba"
 *
 * Greeting is derived from the local clock; the long date is rendered
 * from the supplied ISO string (kept overridable for deterministic
 * tests).
 */
export function HeaderStrip({
  userName,
  isoDate,
}: {
  userName: string;
  /** ISO `YYYY-MM-DD` or full timestamp. */
  isoDate: string;
}) {
  const greeting = getGreeting();
  const longDate = formatDateLong(isoDate);

  return (
    <header
      className="flex h-14 items-center justify-between gap-4"
      data-testid="executive-header-strip"
    >
      <h1 className="truncate text-lg font-medium text-foreground sm:text-xl">
        <span className="text-muted-foreground">{greeting},</span>{' '}
        <span className="font-semibold">{userName}</span>
      </h1>
      <p className="hidden text-sm text-muted-foreground tabular-nums sm:block">
        {longDate}
      </p>
    </header>
  );
}
