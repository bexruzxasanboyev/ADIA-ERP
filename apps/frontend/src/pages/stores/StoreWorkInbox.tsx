import { useMemo } from 'react';
import { PackageCheck, Plus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatQtyUnit, formatRelative } from '@/lib/format';
import { pipelineStageOf } from '@/lib/pipeline';
import type { ReplenishmentRequest } from '@/lib/types';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import {
  StatusTracker,
  WorkCard,
  WorkFeed,
  WorkSection,
} from '@/pages/replenishment/inbox/WorkFeed';
import {
  partitionByBucket,
  storeBucketOf,
  WORK_BUCKET_LABELS,
} from '@/pages/replenishment/inbox/workBuckets';
import { STORE_TRACKER_STEPS, storeTrackerIndex } from './storeInboxTracker';

/**
 * Do'kon — «Ishlarim» (Variant A + mini-xarita). The store manager's ONLY
 * screen: a single feed of large cards in three fixed groups — YANGI /
 * JARAYONDA / TAYYOR — one big primary button per card, plain-Uzbek status
 * lines, and a {@link ChainStrip} mini chain-map per card (the `journey`
 * field, backend in parallel — hidden until it lands).
 *
 *   YANGI     — (empty today: nothing asks a store to accept a decision; the
 *               thin label keeps the three-group grammar identical across
 *               roles).
 *   JARAYONDA — the store's OWN open orders, watch-only: the chain strip (or
 *               the legacy tracker until journey lands) answers "qayerda?".
 *   TAYYOR    — an arrived shipment: «8 kg Napoleon keldi» → [Qabul qilish]
 *               (the existing receive dialog, brak flow inside).
 *
 * Bucketing is the PURE {@link storeBucketOf} (unit-tested); every action
 * delegates to an EXISTING dialog / endpoint — zero new flows.
 */

export interface StoreWorkInboxProps {
  /** The store-scoped request rows (already fetched by the workspace). */
  requests: ReplenishmentRequest[];
  /** The viewer's store location ids (receive items are scoped to these). */
  storeScope: ReadonlySet<number>;
  /** Pulse the header on a new arrival (driven by useInboxAlert). */
  flash?: boolean;
  /** Open the existing receive dialog (brak flow included). */
  onReceive: (req: ReplenishmentRequest) => void;
  /** Open the existing AI proposals dialog. NULL hides the card. */
  onOpenAiProposals: (() => void) | null;
  /** Open the existing create-request flow. NULL hides the CTA. */
  onCreateRequest: (() => void) | null;
  /** Open the detail surface («Batafsil →» — the power tables). */
  onOpenDetails: () => void;
}

export function StoreWorkInbox({
  requests,
  storeScope,
  flash = false,
  onReceive,
  onOpenAiProposals,
  onCreateRequest,
  onOpenDetails,
}: StoreWorkInboxProps) {
  // The three-group split (pure, unit-tested): YANGI / JARAYONDA / TAYYOR.
  const buckets = useMemo(
    () => partitionByBucket(requests, (r) => storeBucketOf(r, storeScope)),
    [requests, storeScope],
  );

  const actionableCount = buckets.tayyor.length + buckets.yangi.length;
  const visibleCount = actionableCount + buckets.jarayonda.length;

  /** "#id · qachon" — the muted second line, everyday words only. */
  const subline = (req: ReplenishmentRequest) =>
    `so‘rov #${req.id} · ${formatRelative(req.created_at)}`;

  return (
    <WorkFeed
      title="Ishlarim"
      count={actionableCount}
      visibleCount={visibleCount}
      flash={flash}
      onOpenDetails={onOpenDetails}
      emptyHint="Yangi jo‘natma kelsa shu yerda chiqadi."
      footer={
        // Two everyday actions — request something / see AI suggestions.
        <div className="flex flex-wrap gap-2 pt-2">
          {onCreateRequest && (
            <Button size="lg" onClick={onCreateRequest}>
              <Plus className="size-4" aria-hidden="true" />
              So‘rov yuborish
            </Button>
          )}
          {onOpenAiProposals && (
            <Button size="lg" variant="outline" onClick={onOpenAiProposals}>
              <Sparkles className="size-4" aria-hidden="true" />
              AI takliflari
            </Button>
          )}
        </div>
      }
    >
      {/* YANGI — kept as a thin label (no store-side decisions exist today). */}
      <WorkSection
        label={WORK_BUCKET_LABELS.yangi}
        count={buckets.yangi.length}
      />

      {/* JARAYONDA — my open orders on their way (watch-only + chain map). */}
      <WorkSection
        label={WORK_BUCKET_LABELS.jarayonda}
        count={buckets.jarayonda.length}
      >
        {buckets.jarayonda.map((req) => {
          const flow = req as FlowRequest;
          return (
            <WorkCard
              key={req.id}
              journey={flow.journey}
              headline={
                <>
                  {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                  {req.product_name} buyurtmangiz
                </>
              }
              subline={subline(req)}
              waitReason={flow.journey?.wait_reason ?? undefined}
              // The legacy tracker carries the strip's job until journey lands.
              tracker={
                flow.journey ? undefined : (
                  <StatusTracker
                    steps={STORE_TRACKER_STEPS}
                    activeIndex={storeTrackerIndex(pipelineStageOf(req))}
                  />
                )
              }
            />
          );
        })}
      </WorkSection>

      {/* TAYYOR — one card per arrived shipment: plain words, ONE big button. */}
      <WorkSection
        label={WORK_BUCKET_LABELS.tayyor}
        count={buckets.tayyor.length}
      >
        {buckets.tayyor.map((req) => {
          const flow = req as FlowRequest;
          const qty = flow.shipped_qty ?? req.qty_needed;
          return (
            <WorkCard
              key={req.id}
              journey={flow.journey}
              headline={`${formatQtyUnit(qty, req.product_unit)} ${req.product_name} keldi`}
              subline={`${req.target_location_name ?? 'Markaziy sklad'} jo‘natdi · ${subline(req)}`}
              primary={{
                label: 'Qabul qilish',
                icon: <PackageCheck className="size-4" aria-hidden="true" />,
                variant: 'success',
                onClick: () => onReceive(req),
              }}
            />
          );
        })}
      </WorkSection>
    </WorkFeed>
  );
}
