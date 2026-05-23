import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import {
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { ApiError, apiRequest } from '@/lib/api-client';
import { formatDateTime, formatQty } from '@/lib/format';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import type {
  ReplenishmentAdvanceResponse,
  ReplenishmentDetail,
} from '@/lib/types';
import { TERMINAL_REPLENISHMENT_STATUSES } from '@/lib/types';
import { TransitionTimeline } from './TransitionTimeline';

/**
 * Detail screen for one replenishment_request. The page wraps two
 * mutating actions:
 *
 *   - `POST /api/replenishment/:id/advance` — step the state machine once;
 *     a 409 `INVALID_TRANSITION` is shown as a friendly Uzbek message.
 *   - `POST /api/replenishment/:id/cancel` — pm-only terminal cancel.
 *
 * Terminal requests (`CLOSED` / `CANCELLED`) hide both actions.
 */
export function ReplenishmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { notify } = useToast();

  const path = id ? `/api/replenishment/${id}` : null;
  const detail = useApiQuery<ReplenishmentDetail>(path);
  // `/api/replenishment/:id` embeds product_name, product_unit,
  // requester_location_name, target_location_name on the request and
  // actor_name on every transition — no extra `/api/products`,
  // `/api/locations`, or `/api/users` round trips needed. The user lookup
  // is also blocked by RBAC for non-pm roles, so calling it here would
  // 403 for store/production/supply managers viewing a request that
  // touches them.

  const [isAdvancing, setIsAdvancing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleAdvance(): Promise<void> {
    if (!id) return;
    setActionError(null);
    setIsAdvancing(true);
    try {
      const result = await apiRequest<ReplenishmentAdvanceResponse>(
        `/api/replenishment/${id}/advance`,
        { method: 'POST' },
      );
      if (result.advanced) {
        notify(
          'success',
          `Holat o‘zgartirildi: ${REPLENISHMENT_STATUS_LABELS[result.status]}.`,
        );
      } else {
        notify('success', `Kutish holati: ${result.reason}`);
      }
      detail.refetch();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'INVALID_TRANSITION') {
        setActionError(
          'Bu holatda o‘tishni amalga oshirib bo‘lmaydi. So‘rovning hozirgi holatini tekshiring.',
        );
      } else {
        setActionError(
          err instanceof ApiError ? err.message : 'O‘tishni bajarib bo‘lmadi.',
        );
      }
    } finally {
      setIsAdvancing(false);
    }
  }

  async function handleCancel(): Promise<void> {
    if (!id) return;
    // TODO(faza-2): replace `window.prompt` with a styled reason dialog —
    // the native prompt breaks the dark-premium aesthetic and skips
    // accessibility hooks. Kept for Faza-1 because cancellations are rare
    // and the value flows through unchanged.
    const reason = window.prompt('Bekor qilish sababi (ixtiyoriy):') ?? '';
    setActionError(null);
    setIsCancelling(true);
    try {
      await apiRequest(`/api/replenishment/${id}/cancel`, {
        method: 'POST',
        body: { reason: reason.trim() === '' ? undefined : reason.trim() },
      });
      notify('success', 'So‘rov bekor qilindi.');
      detail.refetch();
    } catch (err: unknown) {
      setActionError(
        err instanceof ApiError ? err.message : 'Bekor qilib bo‘lmadi.',
      );
    } finally {
      setIsCancelling(false);
    }
  }

  if (detail.isLoading) return <LoadingState />;
  if (detail.error)
    return <ErrorState message={detail.error} onRetry={detail.refetch} />;
  if (!detail.data) return null;

  const { request, transitions } = detail.data;
  const isTerminal = TERMINAL_REPLENISHMENT_STATUSES.includes(request.status);
  const canCancel = user?.role === 'pm' && !isTerminal;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate('/replenishment')}>
        <ArrowLeft className="size-4" aria-hidden="true" />
        So‘rovlar ro‘yxati
      </Button>

      <PageHeader
        title={`So‘rov #${request.id}`}
        description={request.product_name}
        action={
          <div className="flex items-center gap-2">
            {!isTerminal && (
              <Button onClick={handleAdvance} disabled={isAdvancing}>
                {isAdvancing && (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                )}
                Keyingi qadam
              </Button>
            )}
            {canCancel && (
              <Button
                variant="outline"
                onClick={handleCancel}
                disabled={isCancelling}
              >
                {isCancelling && (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                )}
                Bekor qilish
              </Button>
            )}
          </div>
        }
      />

      {actionError && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground"
          role="alert"
        >
          {actionError}
        </p>
      )}

      <Card className="space-y-4 p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Holat">
            <Badge variant={REPLENISHMENT_STATUS_VARIANT[request.status]}>
              {REPLENISHMENT_STATUS_LABELS[request.status]}
            </Badge>
          </Field>
          <Field label="Kerakli miqdor">
            <span className="tabular-nums">
              {formatQty(request.qty_needed)} {request.product_unit}
            </span>
          </Field>
          <Field label="So‘rovchi bo‘g‘in">
            {request.requester_location_name}
          </Field>
          <Field label="Maqsadli bo‘g‘in">
            {request.target_location_name ?? '—'}
          </Field>
          <Field label="Bog‘langan zayafka">
            {request.production_order_id != null ? (
              <Link
                to={`/production-orders`}
                className="text-primary hover:underline"
              >
                #{request.production_order_id}
              </Link>
            ) : (
              '—'
            )}
          </Field>
          <Field label="Bog‘langan sotib olish">
            {request.purchase_order_id != null ? (
              <Link
                to={`/purchase-orders`}
                className="text-primary hover:underline"
              >
                #{request.purchase_order_id}
              </Link>
            ) : (
              '—'
            )}
          </Field>
          <Field label="Yaratilgan">{formatDateTime(request.created_at)}</Field>
          <Field label="Yangilangan">{formatDateTime(request.updated_at)}</Field>
        </div>
        {request.note && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            {request.note}
          </div>
        )}
      </Card>

      <Card>
        <div className="border-b border-border px-4 py-3 text-sm font-medium">
          O‘tishlar tarixi
        </div>
        <TransitionTimeline transitions={transitions} />
      </Card>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
