import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Loader2, Plus, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { apiRequest, ApiError } from '@/lib/api-client';
import { useApiQuery } from '@/hooks/useApiQuery';
import { FLOW_TYPE_LABELS, FLOW_TYPE_OPTIONS } from '@/lib/labels';
import type { FlowType, Location, LocationFlow } from '@/lib/types';

/**
 * EPIC 2.1 — bo'g'inlar orasidagi oqim (connection) boshqaruvi as a dedicated,
 * routed page at `/locations/flows` (previously a modal — LocationFlowsDialog).
 *
 * The PM picks a source and a target bo'g'in plus a flow type and the pair is
 * persisted to `location_flows`. Existing flows are listed with a delete
 * affordance. The change shows up on the dashboard ecosystem aggregate
 * (D-0026) because it projects `location_flows` into `chain_edges`.
 *
 * Contract:
 *   GET    /api/locations/flows       → LocationFlow[]
 *   POST   /api/locations/flows       { from_location_id, to_location_id,
 *                                       flow_type } → { flow }
 *   DELETE /api/locations/flows/:id   → 204
 *
 * PM-only — gated by the route (RoleRoute allow={['pm']}).
 */
export function LocationFlowsPage() {
  const { notify } = useToast();

  // The endpoint pickers + label lookups both need the full locations list.
  const {
    data: locationsData,
    isLoading: locationsLoading,
    error: locationsError,
    refetch: refetchLocations,
  } = useApiQuery<Location[]>('/api/locations');
  const allLocations = useMemo(() => locationsData ?? [], [locationsData]);

  const [flows, setFlows] = useState<LocationFlow[]>([]);
  const [flowsLoading, setFlowsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [flowType, setFlowType] = useState<FlowType>('forward');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const nameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const loc of allLocations) map.set(loc.id, loc.name);
    return map;
  }, [allLocations]);

  async function loadFlows() {
    setFlowsLoading(true);
    setLoadError(null);
    try {
      const data = await apiRequest<LocationFlow[]>('/api/locations/flows');
      setFlows(data);
    } catch (err: unknown) {
      setFlows([]);
      setLoadError(
        err instanceof ApiError ? err.message : 'Oqimlarni yuklab bo‘lmadi.',
      );
    } finally {
      setFlowsLoading(false);
    }
  }

  useEffect(() => {
    void loadFlows();
  }, []);

  async function refresh() {
    try {
      const data = await apiRequest<LocationFlow[]>('/api/locations/flows');
      setFlows(data);
    } catch {
      // Keep the optimistic state on a transient refresh error; a reload
      // re-syncs from the server.
    }
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);

    if (fromId === '' || toId === '') {
      setSubmitError('Manba va qabul bo‘g‘inini tanlang.');
      return;
    }
    if (fromId === toId) {
      setSubmitError('Manba va qabul bo‘g‘ini bir xil bo‘la olmaydi.');
      return;
    }

    setIsSubmitting(true);
    try {
      await apiRequest('/api/locations/flows', {
        method: 'POST',
        body: {
          from_location_id: Number(fromId),
          to_location_id: Number(toId),
          flow_type: flowType,
        },
      });
      notify('success', 'Oqim qo‘shildi.');
      setFromId('');
      setToId('');
      await refresh();
    } catch (err: unknown) {
      setSubmitError(
        err instanceof ApiError ? err.message : 'Oqim qo‘shishda xatolik.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete(flow: LocationFlow) {
    setDeletingId(flow.id);
    try {
      await apiRequest(`/api/locations/flows/${flow.id}`, { method: 'DELETE' });
      notify('success', 'Oqim o‘chirildi.');
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Oqimni o‘chirishda xatolik.',
      );
    } finally {
      setDeletingId(null);
    }
  }

  function labelFor(id: number): string {
    return nameById.get(id) ?? `#${id}`;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Bo‘g‘inlar orasidagi oqimlar"
        description="Manba bo‘g‘indan qabul qiluvchi bo‘g‘inga oqim qo‘shing yoki o‘chiring. O‘zgarish ekotizim sxemasida aks etadi."
        actions={
          <Button asChild variant="outline">
            <Link to="/locations">
              <ArrowLeft className="size-4" aria-hidden="true" />
              Bo‘g‘inlar
            </Link>
          </Button>
        }
      />

      {/* Add flow */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Yangi oqim qo‘shish</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr_1fr_auto] sm:items-end"
          onSubmit={handleAdd}
        >
          <div className="space-y-1.5">
            <Label htmlFor="flow-from">Manba bo‘g‘in</Label>
            <Select
              id="flow-from"
              value={fromId}
              onChange={(e) => setFromId(e.target.value)}
              disabled={locationsLoading}
            >
              <option value="">— Tanlang —</option>
              {allLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="hidden pb-2.5 text-muted-foreground sm:block">
            <ArrowRight className="size-4" aria-hidden="true" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="flow-to">Qabul bo‘g‘in</Label>
            <Select
              id="flow-to"
              value={toId}
              onChange={(e) => setToId(e.target.value)}
              disabled={locationsLoading}
            >
              <option value="">— Tanlang —</option>
              {allLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="flow-type">Oqim turi</Label>
            <Select
              id="flow-type"
              value={flowType}
              onChange={(e) => setFlowType(e.target.value as FlowType)}
            >
              {FLOW_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          <Button type="submit" disabled={isSubmitting || locationsLoading}>
            {isSubmitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="size-4" aria-hidden="true" />
            )}
            Qo‘shish
          </Button>
        </form>

        {submitError && (
          <p
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {submitError}
          </p>
        )}

        {locationsError && (
          <p
            className="rounded-lg border border-border/60 bg-surface-3 px-3 py-2 text-sm text-muted-foreground"
            role="status"
          >
            Bo‘g‘inlar ro‘yxatini yuklab bo‘lmadi.{' '}
            <Button
              type="button"
              variant="link"
              onClick={refetchLocations}
              className="h-auto p-0 text-sm"
            >
              Qayta urinish
            </Button>
          </p>
        )}
        </CardContent>
      </Card>

      {/* Existing flows */}
      <Card>
        <CardHeader className="border-b border-border/60">
          <CardTitle className="flex items-center gap-2">
            Mavjud oqimlar
            <Badge variant="outline" className="tabular-nums">
              {flows.length}
            </Badge>
          </CardTitle>
        </CardHeader>

        {flowsLoading && <LoadingState />}
        {!flowsLoading && loadError && (
          <ErrorState message={loadError} onRetry={loadFlows} />
        )}
        {!flowsLoading && !loadError && flows.length === 0 && (
          <EmptyState message="Hozircha oqimlar yo‘q." />
        )}
        {!flowsLoading && !loadError && flows.length > 0 && (
          <ol className="divide-y divide-border/60">
            {flows.map((flow) => (
              <li
                key={flow.id}
                className="flex items-center gap-3 px-5 py-3 text-sm"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate font-medium">
                    {labelFor(flow.from_location_id)}
                  </span>
                  <ArrowRight
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate font-medium">
                    {labelFor(flow.to_location_id)}
                  </span>
                </div>
                <Badge variant="outline" className="shrink-0 font-normal">
                  {FLOW_TYPE_LABELS[flow.flow_type]}
                </Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={deletingId === flow.id}
                  onClick={() => handleDelete(flow)}
                  aria-label={`${labelFor(flow.from_location_id)} → ${labelFor(
                    flow.to_location_id,
                  )} oqimini o‘chirish`}
                >
                  {deletingId === flow.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </Button>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
