import { Loader2, AlertTriangle, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeaderActions } from '@/components/layout/PageHeaderActions';

/** Centered loading spinner for in-progress data fetches. */
export function LoadingState({ label = 'Yuklanmoqda…' }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Error panel with an optional retry action. */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center gap-3 py-16 text-center"
      role="alert"
    >
      <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Qayta urinish
        </Button>
      )}
    </div>
  );
}

/** Empty-list placeholder. */
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <Inbox className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

/**
 * Page heading block used across module screens — title + Uzbek
 * description only.
 *
 * Header restructure (F4.13 follow-up): per-page action controls
 * (Filter, view toggle, "Yangi …" buttons) no longer live on this row.
 * They relocate to the global app header's right-aligned actions slot —
 * pass them via the `actions` prop (forwarded to `<PageHeaderActions>`)
 * or mount `<PageHeaderActions>` directly in the page. The date/clock +
 * date-range filter live ONLY on the dashboard header now, so the old
 * `dateTime` slot is gone.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  /**
   * Convenience: action controls to push into the global header's
   * actions slot. Equivalent to wrapping them in `<PageHeaderActions>`.
   */
  actions?: React.ReactNode;
}) {
  return (
    <header className="min-w-0">
      {actions && <PageHeaderActions>{actions}</PageHeaderActions>}
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
        {title}
      </h1>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
    </header>
  );
}
