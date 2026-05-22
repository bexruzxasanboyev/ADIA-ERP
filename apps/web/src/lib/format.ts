/**
 * Locale-aware number and date formatting.
 * Numbers and dates are shown in local (uz-UZ) format (CLAUDE.md §2).
 */

const numberFormatter = new Intl.NumberFormat('uz-UZ', {
  maximumFractionDigits: 3,
});

const dateTimeFormatter = new Intl.DateTimeFormat('uz-UZ', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Format a numeric quantity with local grouping (e.g. `1 250,5`). */
export function formatQty(value: number): string {
  return numberFormatter.format(value);
}

/** Format an ISO timestamp as a local date-time string. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateTimeFormatter.format(date);
}
