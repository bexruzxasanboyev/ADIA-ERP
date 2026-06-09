import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowUpRight, CheckCircle2, Plus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatQty } from '@/lib/format';
import { apiRequest, ApiError } from '@/lib/api-client';
import {
  starvedRatio,
  starvedTier,
  type PurchaseSignal,
  type PurchaseSignalsResponse,
} from '@/lib/replenishmentFlow';

interface PurchaseSignalsSectionProps {
  /**
   * Opens the page's existing create-PO dialog prefilled from a signal.
   * `null` when the current user cannot raise a draft (read-only) — the
   * card then renders the disabled affordance instead of the button.
   */
  onCreatePo: ((signal: PurchaseSignal) => void) | null;
}

type LoadState =
  | { kind: 'loading' }
  /** 404 (endpoint not live) / 403 (no scope) — the whole section is hidden. */
  | { kind: 'hidden' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; signals: PurchaseSignal[] };

/**
 * "Xarid signallari" (F-F) — below-min raw-material signals surfaced ABOVE the
 * purchase-orders list so the homashyo boshlig'i can open a draft straight from
 * a starved row. Reads the PINNED `GET /api/purchase-orders/signals` contract.
 *
 * Graceful degradation (the backend ships this endpoint IN PARALLEL):
 *   - 404 (not deployed yet) / 403 (caller lacks raw-warehouse + PM scope)
 *     → render NOTHING. The page keeps working; no scary error for a user
 *       who simply can't see signals.
 *   - any other failure → a small inline error card with a retry.
 *   - in-flight → skeleton cards.
 *   - empty → "hammasi min darajadan yuqori" success line.
 *
 * We fetch directly (not via `useApiQuery`) because we must branch on the HTTP
 * status to decide hide-vs-error, and the shared hook only surfaces a localized
 * message string.
 */
export function PurchaseSignalsSection({
  onCreatePo,
}: PurchaseSignalsSectionProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback((signal?: AbortSignal) => {
    setState({ kind: 'loading' });
    apiRequest<PurchaseSignalsResponse>('/api/purchase-orders/signals', {
      signal,
    })
      .then((res) => {
        if (signal?.aborted) return;
        setState({ kind: 'ready', signals: res.signals ?? [] });
      })
      .catch((err: unknown) => {
        if (signal?.aborted) return;
        // 404 — endpoint not live yet; 403 — user lacks scope. Either way the
        // section simply doesn't exist for this user/session.
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          setState({ kind: 'hidden' });
          return;
        }
        const message =
          err instanceof ApiError
            ? err.message
            : 'Signallarni yuklab bo‘lmadi.';
        setState({ kind: 'error', message });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Hidden — emit nothing at all (no wrapper, no spacing) so the page layout
  // is identical to before the endpoint existed.
  if (state.kind === 'hidden') return null;

  return (
    <section aria-labelledby="purchase-signals-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2
            id="purchase-signals-heading"
            className="flex items-center gap-2 text-lg font-semibold tracking-tight"
          >
            <AlertTriangle
              className="size-4 text-warning"
              aria-hidden="true"
            />
            Xarid signallari
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Min darajadan tushgan xom-ashyo — to‘g‘ridan-to‘g‘ri sotib olish
            so‘rovi oching.
          </p>
        </div>
        {state.kind === 'ready' && state.signals.length > 0 && (
          <Badge variant="warning" aria-label="Signallar soni">
            {formatQty(state.signals.length)} ta signal
          </Badge>
        )}
      </div>

      {state.kind === 'loading' && <SignalsSkeleton />}

      {state.kind === 'error' && (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <AlertTriangle
            className="size-6 text-destructive"
            aria-hidden="true"
          />
          <p className="text-sm text-muted-foreground" role="alert">
            {state.message}
          </p>
          <Button variant="outline" size="sm" onClick={() => load()}>
            Qayta urinish
          </Button>
        </Card>
      )}

      {state.kind === 'ready' && state.signals.length === 0 && (
        <Card className="flex flex-col items-center gap-2 p-8 text-center">
          <CheckCircle2 className="size-6 text-success" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            Signal yo‘q — hammasi min darajadan yuqori ✅
          </p>
        </Card>
      )}

      {state.kind === 'ready' && state.signals.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {state.signals.map((s) => (
            <SignalCard
              key={`${s.location_id}-${s.product_id}`}
              signal={s}
              onCreatePo={onCreatePo}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Three placeholder cards while the signals request is in flight. */
function SignalsSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Signallar yuklanmoqda…</span>
      {[0, 1, 2].map((i) => (
        <Card key={i} className="space-y-3 p-4">
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-2 w-full animate-pulse rounded bg-muted" />
          <div className="h-8 w-full animate-pulse rounded bg-muted" />
        </Card>
      ))}
    </div>
  );
}

/** Badge variant for the starved-tier chip + Tailwind tone for the bar fill. */
const TIER_BADGE: Record<'critical' | 'low', 'danger' | 'warning'> = {
  critical: 'danger',
  low: 'warning',
};
const TIER_BAR: Record<'critical' | 'low', string> = {
  critical: 'bg-destructive',
  low: 'bg-warning',
};
const TIER_LABEL: Record<'critical' | 'low', string> = {
  critical: 'Tanqis',
  low: 'Past',
};

function SignalCard({
  signal,
  onCreatePo,
}: {
  signal: PurchaseSignal;
  onCreatePo: ((signal: PurchaseSignal) => void) | null;
}) {
  const tier = starvedTier(signal);
  const ratioPct = Math.round(starvedRatio(signal) * 100);
  const unit = signal.unit ?? '';
  const hasOpenPo = signal.open_purchase_order_id != null;
  const hasOpenRequest = signal.open_request_id != null;
  // An in-flight document blocks a duplicate draft (Invariant 2). The whole
  // card greys out so the eye skips to the actionable ones.
  const blocked = hasOpenPo || hasOpenRequest;

  return (
    <Card
      className={cn(
        'flex flex-col gap-3 p-4 transition-colors',
        blocked && 'opacity-70',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium" title={signal.name}>
            {signal.name}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {signal.location_name}
          </p>
        </div>
        <Badge
          variant={TIER_BADGE[tier]}
          className="shrink-0 px-2 text-[11px]"
          aria-label={`Holat: ${TIER_LABEL[tier]}, min'ning ${ratioPct}%`}
        >
          {TIER_LABEL[tier]}
        </Badge>
      </div>

      {/* Starved ratio — qty / min, with a colored fill bar. */}
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2 text-sm tabular-nums">
          <span className="font-medium">
            {formatQty(signal.qty)} {unit}
          </span>
          <span className="text-xs text-muted-foreground">
            min {formatQty(signal.min_level)} {unit}
          </span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={ratioPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Ostatka min'ga nisbatan"
        >
          <div
            className={cn('h-full rounded-full transition-all', TIER_BAR[tier])}
            style={{ width: `${Math.max(ratioPct, 4)}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Tavsiya etilgan</span>
        <span className="font-medium tabular-nums text-foreground">
          {formatQty(signal.suggested_qty)} {unit}
        </span>
      </div>

      {/* Action — link chip when a document is already open, else a button. */}
      {hasOpenPo ? (
        <Button asChild variant="outline" size="sm" className="justify-center">
          <Link to={`/purchase-orders?focus=${signal.open_purchase_order_id}`}>
            <ArrowUpRight className="size-4" aria-hidden="true" />
            PO #{signal.open_purchase_order_id} ochiq
          </Link>
        </Button>
      ) : hasOpenRequest ? (
        <Button asChild variant="outline" size="sm" className="justify-center">
          <Link to={`/replenishment/${signal.open_request_id}`}>
            <ArrowUpRight className="size-4" aria-hidden="true" />
            So‘rov #{signal.open_request_id} ochiq
          </Link>
        </Button>
      ) : onCreatePo ? (
        <Button
          size="sm"
          className="justify-center"
          onClick={() => onCreatePo(signal)}
        >
          <Plus className="size-4" aria-hidden="true" />
          PO yaratish
        </Button>
      ) : (
        <Badge
          variant="secondary"
          className="justify-center py-1.5"
          aria-label="Faqat o‘qish rejimi"
        >
          Faqat o‘qish
        </Badge>
      )}
    </Card>
  );
}
