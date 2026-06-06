import { useEffect, useState } from 'react';
import {
  DateRangeFilter,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { formatDateLong } from '@/lib/format';

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

interface DashboardHeaderSlotProps {
  isoDate: string;
  range: DateRangeValue;
  onRangeChange: (next: DateRangeValue) => void;
}

/**
 * Dashboard content for the global app header (rendered via HeaderSlot).
 * The personal greeting now lives on the home launcher; the header keeps
 * the date + live clock centered, with the date-range filter on the right.
 */
export function DashboardHeaderSlot({
  isoDate,
  range,
  onRangeChange,
}: DashboardHeaderSlotProps) {
  const longDate = formatDateLong(isoDate);
  const clock = useClock();

  return (
    <div className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr] items-center gap-x-6">
      {/* Left — spacer keeps the datetime true-centered in the viewport */}
      <span aria-hidden="true" />

      {/* Middle — date + clock, true-centered in the viewport */}
      <p
        className="hidden items-center gap-2.5 text-sm text-muted-foreground tabular-nums xl:flex"
        data-testid="dashboard-header-datetime"
      >
        <span>{longDate}</span>
        <span aria-hidden="true" className="text-border">
          ·
        </span>
        <span
          className="text-base font-semibold text-foreground"
          data-testid="dashboard-header-clock"
        >
          {clock}
        </span>
      </p>
      {/* Mobile / tablet placeholder so the grid keeps three columns even
          when the center datetime is hidden below xl. */}
      <span aria-hidden="true" className="xl:hidden" />

      {/* Right — filter + calendar */}
      <div className="flex justify-end">
        <DateRangeFilter value={range} onChange={onRangeChange} />
      </div>
    </div>
  );
}
