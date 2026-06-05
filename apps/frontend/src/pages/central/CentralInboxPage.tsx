import { useMemo, useState, type FormEvent } from 'react';
import { Check, Loader2, Warehouse, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import type { Location, ReplenishmentStatus } from '@/lib/types';

/**
 * Markaziy sklad — kiruvchi so'rovlar (incoming store requests inbox).
 *
 * The central warehouse manager (or PM, with a central-warehouse picker)
 * reviews replenishment requests targeted at the central warehouse and
 * either accepts (ships / fulfils) or rejects them with a reason.
 *
 * Backend contracts:
 *   - List:   GET  /api/replenishment/incoming?location_id=<central>
 *               → { items: IncomingRequest[] }
 *   - Accept: POST /api/replenishment/:id/accept
 *   - Reject: POST /api/replenishment/:id/reject  body { reason }
 *   - Picker: GET  /api/locations  (filtered to type === 'central_warehouse')
 *
 * The backend RBAC-scopes the list; a scoped central manager is pinned to
 * their location, so the picker is PM-only.
 */
interface IncomingRequest {
  id: number;
  product_id: number;
  product_name: string;
  requester_location_name: string;
  qty_needed: number;
  status: ReplenishmentStatus;
  created_at: string;
}

interface IncomingResponse {
  items: IncomingRequest[];
}

export function CentralInboxPage() {
  const { user, activeLocationId } = useAuth();
  const { notify } = useToast();
  const isPm = user?.role === 'pm';

  // PM picks a central warehouse; a scoped central manager is pinned to
  // their active location (falling back to their primary location_id).
  const [pickedCentralId, setPickedCentralId] = useState<string>('');
  const scopedCentralId = isPm
    ? pickedCentralId
    : String(activeLocationId ?? user?.location_id ?? '');
  const centralIdNum = scopedCentralId === '' ? null : Number(scopedCentralId);

  const locations = useApiQuery<Location[]>(isPm ? '/api/locations' : null);
  const centralOptions = useMemo(
    () =>
      (locations.data ?? []).filter((l) => l.type === 'central_warehouse'),
    [locations.data],
  );

  const incoming = useApiQuery<IncomingResponse>(
    centralIdNum === null
      ? null
      : `/api/replenishment/incoming?location_id=${centralIdNum}`,
  );
  const rows = incoming.data?.items ?? [];

  const [busyId, setBusyId] = useState<number | null>(null);
  const [rejectTarget, setRejectTarget] = useState<IncomingRequest | null>(
    null,
  );

  async function handleAccept(row: IncomingRequest) {
    setBusyId(row.id);
    try {
      await apiRequest(`/api/replenishment/${row.id}/accept-central`, {
        method: 'POST',
        body: { location_id: centralIdNum },
      });
      notify('success', `#${row.id} qabul qilindi.`);
      incoming.refetch();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Qabul qilib bo‘lmadi.',
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        title="Markaziy sklad — kiruvchi so‘rovlar"
        description="Do‘konlardan kelgan to‘ldirish so‘rovlarini qabul qiling yoki rad eting."
      />

      {isPm && (
        <div className="space-y-1">
          <Label htmlFor="central-picker">Markaziy sklad</Label>
          <Select
            id="central-picker"
            className="w-full sm:w-72"
            value={pickedCentralId}
            onChange={(e) => setPickedCentralId(e.target.value)}
          >
            <option value="">— Markaziy skladni tanlang —</option>
            {centralOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {centralIdNum === null ? (
        <Card>
          <EmptyState
            message={
              isPm
                ? 'Boshlash uchun markaziy skladni tanlang.'
                : 'Sizga markaziy sklad biriktirilmagan.'
            }
          />
        </Card>
      ) : (
        <Card>
          <header className="flex items-center gap-2 border-b border-border/60 p-5">
            <Warehouse className="size-4 text-primary" aria-hidden="true" />
            <div className="space-y-0.5">
              <h2 className="text-base font-semibold">Kiruvchi so‘rovlar</h2>
              <p className="text-xs text-muted-foreground">
                Tasdiqlangan so‘rov jo‘natma uchun navbatga qo‘shiladi.
              </p>
            </div>
          </header>

          {incoming.isLoading && <LoadingState />}
          {!incoming.isLoading && incoming.error && (
            <ErrorState message={incoming.error} onRetry={incoming.refetch} />
          )}
          {!incoming.isLoading && !incoming.error && rows.length === 0 && (
            <EmptyState message="Hozircha kiruvchi so‘rov yo‘q." />
          )}
          {!incoming.isLoading && !incoming.error && rows.length > 0 && (
            <div className="scrollbar-thin overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>So‘rovchi bo‘g‘in</TableHead>
                    <TableHead>Mahsulot</TableHead>
                    <TableHead className="text-right">Miqdor</TableHead>
                    <TableHead>Holat</TableHead>
                    <TableHead>Yaratilgan</TableHead>
                    <TableHead className="text-right">Amal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-muted-foreground">
                        #{row.id}
                      </TableCell>
                      <TableCell>{row.requester_location_name}</TableCell>
                      <TableCell className="font-medium">
                        {row.product_name}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.qty_needed}
                      </TableCell>
                      <TableCell>
                        <Badge variant={REPLENISHMENT_STATUS_VARIANT[row.status]}>
                          {REPLENISHMENT_STATUS_LABELS[row.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(row.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleAccept(row)}
                            disabled={busyId !== null}
                          >
                            {busyId === row.id ? (
                              <Loader2
                                className="size-4 animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <Check className="size-4" aria-hidden="true" />
                            )}
                            Qabul qil
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setRejectTarget(row)}
                            disabled={busyId !== null}
                          >
                            <X className="size-4" aria-hidden="true" />
                            Rad et
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      )}

      <RejectDialog
        request={rejectTarget}
        onOpenChange={(open) => {
          if (!open) setRejectTarget(null);
        }}
        onRejected={() => {
          setRejectTarget(null);
          incoming.refetch();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reject (rad etish) dialog — captures a required reason.
// ---------------------------------------------------------------------------

function RejectDialog({
  request,
  onOpenChange,
  onRejected,
}: {
  request: IncomingRequest | null;
  onOpenChange: (open: boolean) => void;
  onRejected: () => void;
}) {
  const { notify } = useToast();
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = request !== null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request === null) return;
    const trimmed = reason.trim();
    if (trimmed === '') {
      setError('Rad etish sababini kiriting.');
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      await apiRequest(`/api/replenishment/${request.id}/reject-central`, {
        method: 'POST',
        body: { reason: trimmed },
      });
      notify('success', `#${request.id} rad etildi.`);
      setReason('');
      onRejected();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.message : 'Rad etib bo‘lmadi.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setReason('');
          setError(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>So‘rovni rad etish</DialogTitle>
          <DialogDescription>
            {request
              ? `#${request.id} · ${request.product_name} — ${request.requester_location_name}`
              : ''}
          </DialogDescription>
        </DialogHeader>

        <form id="reject-form" className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="reject-reason">Sabab</Label>
            <Textarea
              id="reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Masalan: ombor qoldig‘i yetarli emas"
              maxLength={500}
              disabled={isSubmitting}
              required
            />
          </div>
          {error && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Bekor qilish
          </Button>
          <Button
            type="submit"
            form="reject-form"
            variant="destructive"
            disabled={isSubmitting}
          >
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Rad etish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
