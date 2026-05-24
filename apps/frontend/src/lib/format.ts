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

/**
 * Format an ISO timestamp as a relative Uzbek string ("hozir",
 * "5 daqiqa oldin", "2 soat oldin", "3 kun oldin"). Falls back to
 * `formatDateTime` when the input is invalid or the gap is older than
 * a week. `now` parameter is overridable for deterministic tests.
 */
export function formatRelative(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffMs = now.getTime() - date.getTime();
  const futureLabel = diffMs < 0 ? 'keyin' : 'oldin';
  const abs = Math.abs(diffMs);

  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;

  if (abs < 30 * SEC) return 'hozir';
  if (abs < HOUR) {
    const m = Math.max(1, Math.floor(abs / MIN));
    return `${m} daqiqa ${futureLabel}`;
  }
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    return `${h} soat ${futureLabel}`;
  }
  if (abs < WEEK) {
    const d = Math.floor(abs / DAY);
    return `${d} kun ${futureLabel}`;
  }
  return formatDateTime(iso);
}
