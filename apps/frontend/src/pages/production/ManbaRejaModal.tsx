import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  CheckCircle2,
  Factory,
  Loader2,
  Package,
  ShoppingCart,
  Sparkles,
  Warehouse,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { NumberInput } from '@/components/ui/number-input';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ApiError, apiRequest } from '@/lib/api-client';
import { formatQty } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import type {
  ExecutePlanBody,
  ExecutePlanResponse,
  ExecutedPlanLine,
  PlanLineAction,
  PlanLineKind,
  ProductionPlanLine,
  ProductionPlanResponse,
} from '@/lib/replenishmentFlow';

/**
 * "Manba reja" — the N-component source-plan modal (cross-department-flow §6.4),
 * opened from an INCOMING production request card. It generalises the old 1-зг /
 * 1-krem dialog to every decoration-BOM line:
 *
 *   1. GET /api/production-plan?product_id&qty&location_id → per-line status.
 *   2. Per line: a kind chip (Xom-ashyo / O'z з/г / Joyida / <Producer nomi>),
 *      need, availability (at_source / at_raw), and a per-line ACTION select
 *      pre-selected to the backend `suggested`. A `use_ready` line also exposes
 *      a qty_ready NumberInput for PARTIAL use.
 *   3. Submit → POST /api/production-plan/execute (one transaction) → a result
 *      list of created docs (movement / zayafka / so'rov ids; `waiter_linked` →
 *      "mavjud so'rovga ulandi"). Then the boards refresh.
 *
 * Validation errors and the PM-403 (read-and-recommend) surface as friendly
 * Uzbek toasts; the GET itself is RBAC-allowed for the PM so they can still see
 * the recommendation.
 */

interface ManbaRejaModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The incoming production request the plan is built for. */
  request: FlowRequest | null;
  /** The production location to plan into (the отдел / sex id). */
  locationId: number;
  /** Whether the operator may execute (false → PM read-only). */
  canExecute: boolean;
  /** Refetch the boards after a successful execute. */
  onDone: () => void;
}

/** Uzbek label + icon for a plan line's kind chip. */
function kindChip(line: ProductionPlanLine): {
  label: string;
  icon: typeof Warehouse;
  variant: 'outline' | 'info' | 'secondary';
} {
  switch (line.kind) {
    case 'raw':
      return { label: 'Xom-ashyo', icon: Warehouse, variant: 'outline' };
    case 'semi_own':
      return { label: 'O‘z з/г', icon: Factory, variant: 'secondary' };
    case 'semi_inplace':
      return { label: 'Joyida', icon: Factory, variant: 'secondary' };
    case 'semi_producer':
      return {
        label: line.producer?.name ?? 'Producer',
        icon: Factory,
        variant: 'info',
      };
    default:
      return { label: '—', icon: Package, variant: 'outline' };
  }
}

/** Uzbek labels for the per-line action select. */
const ACTION_LABELS: Record<PlanLineAction, string> = {
  use_ready: 'Tayyordan',
  make: '0 dan tayyorlash',
  order: 'Producerga so‘rov',
  transfer: 'Ko‘chirish',
  purchase: 'Xom-ashyo so‘rovi',
};

/**
 * Which actions a kind allows in the select (the suggested one is always
 * included). Keeps the operator from picking an action the backend will reject.
 */
const ACTIONS_BY_KIND: Record<PlanLineKind, PlanLineAction[]> = {
  raw: ['transfer', 'purchase'],
  semi_own: ['use_ready', 'make'],
  semi_inplace: ['make'],
  semi_producer: ['use_ready', 'transfer', 'order'],
};

function actionOptions(line: ProductionPlanLine): PlanLineAction[] {
  const base = ACTIONS_BY_KIND[line.kind] ?? [line.suggested];
  return base.includes(line.suggested) ? base : [line.suggested, ...base];
}

/** Per-line operator choice. */
interface LineChoice {
  action: PlanLineAction;
  /** Partial qty_ready for `use_ready`; null = full `qty_ready`. */
  qtyReady: number | null;
}

export function ManbaRejaModal({
  open,
  onOpenChange,
  request,
  locationId,
  canExecute,
  onDone,
}: ManbaRejaModalProps) {
  const { notify } = useToast();

  // Build the plan query only while open + we have a request. `product_id`,
  // `qty` and `location_id` come straight off the request being planned.
  const planUrl =
    open && request !== null
      ? `/api/production-plan?product_id=${request.product_id}` +
        `&qty=${request.qty_needed}&location_id=${locationId}`
      : null;
  const plan = useApiQuery<ProductionPlanResponse>(planUrl);

  const lines = useMemo(() => plan.data?.lines ?? [], [plan.data]);

  const [choices, setChoices] = useState<Record<number, LineChoice>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ExecutedPlanLine[] | null>(null);

  // Seed each line's choice to the backend `suggested` once the plan lands.
  useEffect(() => {
    if (!open) {
      setResult(null);
      return;
    }
    const next: Record<number, LineChoice> = {};
    for (const line of lines) {
      next[line.component_product_id] = {
        action: line.suggested,
        qtyReady: null,
      };
    }
    setChoices(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan.data]);

  function setAction(componentId: number, action: PlanLineAction) {
    setChoices((prev) => ({
      ...prev,
      [componentId]: { action, qtyReady: prev[componentId]?.qtyReady ?? null },
    }));
  }

  function setQtyReady(componentId: number, qty: number | null) {
    setChoices((prev) => ({
      ...prev,
      [componentId]: {
        action: prev[componentId]?.action ?? 'use_ready',
        qtyReady: qty,
      },
    }));
  }

  const productName = request?.product_name ?? 'mahsulot';

  async function handleSubmit() {
    if (!request || !canExecute || submitting) return;
    setSubmitting(true);
    const body: ExecutePlanBody = {
      request_id: request.id,
      product_id: request.product_id,
      qty: request.qty_needed,
      location_id: locationId,
      decisions: lines.map((line) => {
        const choice = choices[line.component_product_id];
        const action = choice?.action ?? line.suggested;
        const decision: ExecutePlanBody['decisions'][number] = {
          component_product_id: line.component_product_id,
          action,
        };
        // Only send qty_ready for a partial use_ready entry.
        if (action === 'use_ready' && choice?.qtyReady != null) {
          decision.qty_ready = choice.qtyReady;
        }
        return decision;
      }),
    };

    try {
      const res = await apiRequest<ExecutePlanResponse>(
        '/api/production-plan/execute',
        { method: 'POST', body },
      );
      setResult(res.executed);
      notify('success', `Manba reja bajarildi — ${res.executed.length} ta hujjat.`);
      onDone();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) {
        notify(
          'error',
          'Sizda bajarish huquqi yo‘q — bu faqat ko‘rish va tavsiya rejimi.',
        );
      } else {
        notify(
          'error',
          err instanceof ApiError
            ? err.message
            : 'Manba rejani bajarib bo‘lmadi. Qayta urinib ko‘ring.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden="true" />
            Manba reja — {productName}
          </DialogTitle>
          <DialogDescription>
            Har bir komponent uchun manba va qaror. Tasdiqlangach hujjatlar bitta
            tranzaksiyada chiqadi; bor qismlar rezerv qilinadi.
          </DialogDescription>
        </DialogHeader>

        {plan.isLoading && <LoadingState />}
        {!plan.isLoading && plan.error && (
          <ErrorState message={plan.error} onRetry={plan.refetch} />
        )}
        {!plan.isLoading && !plan.error && lines.length === 0 && (
          <EmptyState message="Bu mahsulot uchun manba reja yo‘q (retsept topilmadi)." />
        )}

        {/* RESULT view — the created documents after a successful execute. */}
        {result !== null ? (
          <ExecuteResult lines={result} />
        ) : (
          !plan.isLoading &&
          !plan.error &&
          lines.length > 0 && (
            <div className="scrollbar-thin max-h-[55vh] space-y-2 overflow-y-auto">
              {lines.map((line) => (
                <PlanLineRow
                  key={line.component_product_id}
                  line={line}
                  choice={
                    choices[line.component_product_id] ?? {
                      action: line.suggested,
                      qtyReady: null,
                    }
                  }
                  disabled={submitting || !canExecute}
                  onAction={(a) => setAction(line.component_product_id, a)}
                  onQtyReady={(q) => setQtyReady(line.component_product_id, q)}
                />
              ))}
            </div>
          )
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {result !== null ? 'Yopish' : 'Bekor qilish'}
          </Button>
          {result === null && (
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !canExecute || lines.length === 0}
              title={
                !canExecute
                  ? 'Faqat ishlab chiqarish boshlig‘i bajara oladi'
                  : undefined
              }
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Factory className="size-4" aria-hidden="true" />
              )}
              Boshlash
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// PlanLineRow — one component: name + kind chip · need · availability ·
// per-line action select (+ qty_ready NumberInput for partial use_ready).
// ---------------------------------------------------------------------------

function PlanLineRow({
  line,
  choice,
  disabled,
  onAction,
  onQtyReady,
}: {
  line: ProductionPlanLine;
  choice: LineChoice;
  disabled: boolean;
  onAction: (a: PlanLineAction) => void;
  onQtyReady: (q: number | null) => void;
}) {
  const chip = kindChip(line);
  const ChipIcon = chip.icon;
  const options = actionOptions(line);
  const showQtyReady = choice.action === 'use_ready';

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{line.name}</span>
          <Badge variant={chip.variant} className="gap-1">
            <ChipIcon className="size-3" aria-hidden="true" />
            {chip.label}
          </Badge>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          Kerak: {formatQty(line.need)} {line.unit}
        </span>
      </div>

      {/* Availability snapshot — at_source / at_raw, only the relevant ones. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {line.available.at_source != null && (
          <span className="tabular-nums">
            Manbada: {formatQty(line.available.at_source)} {line.unit}
          </span>
        )}
        {line.available.at_raw != null && (
          <span className="tabular-nums">
            Omborda: {formatQty(line.available.at_raw)} {line.unit}
          </span>
        )}
        <span className="tabular-nums">
          Tayyor: {formatQty(line.qty_ready)} {line.unit}
        </span>
        {line.open_request_id != null && (
          <Badge variant="outline" className="text-[10px]">
            Ochiq so‘rov #{line.open_request_id}
          </Badge>
        )}
      </div>

      {/* Per-line decision: action select + (optional) partial qty_ready. */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Select
          value={choice.action}
          onChange={(e) => onAction(e.target.value as PlanLineAction)}
          disabled={disabled}
          aria-label={`${line.name} uchun qaror`}
          className="h-8 w-auto min-w-44 text-xs"
        >
          {options.map((a) => (
            <option key={a} value={a}>
              {ACTION_LABELS[a]}
              {a === line.suggested ? ' (tavsiya)' : ''}
            </option>
          ))}
        </Select>

        {showQtyReady && (
          <div className="flex items-center gap-1.5">
            <NumberInput
              decimals
              min={0}
              max={line.qty_ready}
              value={choice.qtyReady}
              onValueChange={onQtyReady}
              placeholder={formatQty(line.qty_ready)}
              aria-label={`${line.name} tayyordan ishlatiladigan miqdor`}
              disabled={disabled}
              className="h-8 w-28"
            />
            <span className="text-xs text-muted-foreground">{line.unit}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExecuteResult — the created documents after a successful transactional run.
// Each line names its action + the created doc id (movement / zayafka / so'rov);
// a merged sub-request shows the "mavjud so'rovga ulandi" badge.
// ---------------------------------------------------------------------------

function ExecuteResult({ lines }: { lines: ExecutedPlanLine[] }) {
  if (lines.length === 0) {
    return (
      <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        Hech qanday hujjat yaratilmadi (hammasi allaqachon tayyor edi).
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {lines.map((line, idx) => (
        <li
          key={`${line.component_product_id}-${idx}`}
          className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm"
        >
          <ResultIcon action={line.action} />
          <span className="font-medium">{resultActionLabel(line)}</span>
          {line.movement_id != null && (
            <Badge variant="outline" className="text-[10px]">
              ko‘chirish #{line.movement_id}
            </Badge>
          )}
          {line.production_order_id != null && (
            <Badge variant="outline" className="text-[10px]">
              zayafka #{line.production_order_id}
            </Badge>
          )}
          {line.request_id != null && (
            <Badge variant="outline" className="text-[10px]">
              so‘rov #{line.request_id}
            </Badge>
          )}
          {line.waiter_linked && (
            <Badge variant="info" className="text-[10px]">
              mavjud so‘rovga ulandi
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

function resultActionLabel(line: ExecutedPlanLine): string {
  switch (line.action) {
    case 'transfer':
      return 'Ko‘chirildi (rezerv)';
    case 'make':
      return 'Zayafka ochildi';
    case 'order':
      return 'Producerga so‘rov yuborildi';
    case 'purchase':
      return 'Xom-ashyo so‘rovi yaratildi';
    case 'use_ready':
      return 'Tayyordan ishlatildi';
    default:
      return 'Bajarildi';
  }
}

function ResultIcon({ action }: { action: PlanLineAction }) {
  const cls = cn('size-4 shrink-0 text-emerald-600 dark:text-emerald-300');
  switch (action) {
    case 'transfer':
    case 'use_ready':
      return <ArrowRightLeft className={cls} aria-hidden="true" />;
    case 'make':
      return <Factory className={cls} aria-hidden="true" />;
    case 'order':
      return <CheckCircle2 className={cls} aria-hidden="true" />;
    case 'purchase':
      return <ShoppingCart className={cls} aria-hidden="true" />;
    default:
      return <CheckCircle2 className={cls} aria-hidden="true" />;
  }
}
