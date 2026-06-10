import { type ReactNode } from 'react';
import { CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { Journey } from '@/lib/replenishmentFlow';
import { ChainStrip } from './ChainStrip';

/**
 * Phase F-V — the SHARED simple-mode «Ishlarim» kit (owner: "tizim oson va
 * sodda bo'lishi kerak — hodimlar qiynalmasin"; research §4 / Rule 1: one
 * screen per role = a single vertical card feed of "what needs me now").
 *
 * Generalised from the store pilot (StoreWorkInbox) so every frontline role —
 * store, central, отдел, homashyo — renders the SAME calm action feed:
 *   - <WorkFeed>        — the centred max-w-2xl shell: «Ishlarim · N» header
 *                         + optional «Batafsil →» escape hatch + a calm success
 *                         empty-state. A `flash` flag (driven by useInboxAlert)
 *                         pulses the header when the count rises.
 *   - <WorkCard>        — one task: a plain-language headline (NO status terms),
 *                         a muted "kim · #id · sana" line, ONE big primary button
 *                         + an optional secondary (Rad — destructive outline),
 *                         a busy spinner state, and an optional `tracker` slot.
 *   - <StatusTracker>   — research Rule 6: a ●●○ linear strip with everyday
 *                         labels (Yuborildi → Tayyorlanmoqda → Yo'lda → Keldi).
 *
 * Deliberately PRESENTATION-ONLY: the host owns the data + every action, and
 * each action delegates to an EXISTING dialog / endpoint — no new flows, no new
 * invariants. The kit only standardises the LOOK and the interaction surface.
 */

// ---------------------------------------------------------------------------
// <WorkFeed> — the shell.
// ---------------------------------------------------------------------------

export interface WorkFeedProps {
  /** Header label — always «Ishlarim» across roles, kept a prop for clarity. */
  title: string;
  /** The actionable count rendered in the header badge. */
  count: number;
  /** Optional «Batafsil →» escape hatch to the power view (kanban/table). */
  onOpenDetails?: (() => void) | null;
  /** Pulse the header once (useInboxAlert flips this on a count increase). */
  flash?: boolean;
  /** Plain-language empty-state line (defaults to a calm "nothing waiting"). */
  emptyTitle?: string;
  emptyHint?: string;
  /**
   * Total cards VISIBLE across the feed's sections (actionable + watch-only).
   * The success empty-state hides while anything is on screen, even when the
   * actionable `count` is 0 (e.g. only Jarayonda watch cards remain). Defaults
   * to `count`.
   */
  visibleCount?: number;
  /** The cards (and any trailing actions) the host renders into the feed. */
  children?: ReactNode;
  /** Trailing actions row under the feed (e.g. So'rov yuborish / AI takliflari). */
  footer?: ReactNode;
}

export function WorkFeed({
  title,
  count,
  onOpenDetails,
  flash = false,
  emptyTitle = 'Sizda kutilayotgan ish yo‘q',
  emptyHint = 'Yangi ish kelsa shu yerda chiqadi.',
  visibleCount,
  children,
  footer,
}: WorkFeedProps) {
  const hasWork = count > 0;
  const hasCards = (visibleCount ?? count) > 0;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* Header — a count the staff can read at a glance; pulses on a new task. */}
      <div
        className={cn(
          'flex items-center justify-between rounded-lg px-1',
          flash && 'motion-safe:animate-inbox-flash',
        )}
      >
        <h2 className="flex items-center gap-1 text-lg font-semibold">
          {title}
          <Badge
            variant={hasWork ? 'warning' : 'success'}
            className="ml-1 align-middle tabular-nums"
          >
            {count}
          </Badge>
        </h2>
        {onOpenDetails && (
          <Button variant="ghost" size="sm" onClick={onOpenDetails}>
            Batafsil →
          </Button>
        )}
      </div>

      {children}

      {/* Calm empty state — the staff knows nothing is waiting on them. */}
      {!hasWork && !hasCards && (
        <Card className="flex flex-col items-center gap-2 p-8 text-center">
          <CheckCircle2 className="size-8 text-success" aria-hidden="true" />
          <p className="text-sm font-medium">{emptyTitle}</p>
          <p className="text-xs text-muted-foreground">{emptyHint}</p>
        </Card>
      )}

      {footer}
    </div>
  );
}

// ---------------------------------------------------------------------------
// <WorkSection> — one of the three feed groups (YANGI / JARAYONDA / TAYYOR).
// ---------------------------------------------------------------------------

export interface WorkSectionProps {
  /** Group label — «Yangi», «Jarayonda» or «Tayyor». */
  label: string;
  /** Cards inside the group; `0` collapses the section to a thin label. */
  count: number;
  children?: ReactNode;
}

/**
 * Variant A + mini-xarita: every frontline feed renders the SAME three groups
 * in the SAME order — Yangi (kartani qabul qilaman) → Jarayonda (kutilmoqda)
 * → Tayyor (yakuniy harakat). An empty group collapses to a thin muted label
 * so the grammar stays visible without stealing space.
 */
export function WorkSection({ label, count, children }: WorkSectionProps) {
  if (count === 0) {
    return (
      <p className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/40">
        {label} · 0
      </p>
    );
  }
  return (
    <section aria-label={`${label} — ${count} ta`} className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </h3>
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// <WorkCard> — one task.
// ---------------------------------------------------------------------------

export interface WorkCardAction {
  /** Button label (everyday Uzbek — «Jo'natish», «Qabul qilish», «Tayyor …»). */
  label: string;
  /** The icon shown left of the label. */
  icon: ReactNode;
  onClick: () => void;
  /** PRIMARY uses `success` by default; pass to override. */
  variant?: 'success' | 'default';
}

export interface WorkCardProps {
  /** Plain-language headline — a full sentence, NO status terms. */
  headline: ReactNode;
  /** Muted second line — typically "kim · #id · sana". */
  subline?: ReactNode;
  /** The ONE big primary action. Omit to render an info-only card. */
  primary?: WorkCardAction;
  /** Optional secondary action — rendered as a «Rad» destructive outline by
   *  default (set `secondaryVariant: 'muted'` for a neutral one, e.g. «Manba
   *  reja»). */
  secondaryLabel?: string;
  onSecondary?: () => void;
  secondaryVariant?: 'destructive' | 'muted';
  /** Disable + spinner the primary (and hide the secondary) while in flight. */
  busy?: boolean;
  /** Optional StatusTracker (or any node) under the headline block. */
  tracker?: ReactNode;
  /**
   * Mini chain-map (Variant A + mini-xarita): when present and well-formed,
   * a {@link ChainStrip} renders on TOP of the card showing where the order
   * sits in the chain. Absent/malformed → no strip (backend lands in parallel).
   */
  journey?: Journey | null;
  /**
   * Plain-Uzbek "why am I waiting" line. Rendered as a calm muted status line
   * ONLY when there is no primary action — a blocked card explains itself
   * instead of dead-ending. Hosts typically pass
   * `journey?.wait_reason ?? <fallback>`.
   */
  waitReason?: string | null;
}

export function WorkCard({
  headline,
  subline,
  primary,
  secondaryLabel,
  onSecondary,
  secondaryVariant = 'destructive',
  busy = false,
  tracker,
  journey,
  waitReason,
}: WorkCardProps) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <ChainStrip journey={journey} />
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-semibold leading-snug">{headline}</p>
          {subline && (
            <p className="truncate text-xs text-muted-foreground">{subline}</p>
          )}
        </div>
        {primary && (
          <div className="flex shrink-0 items-center gap-2">
            {secondaryLabel && onSecondary && !busy && (
              <Button
                variant="outline"
                size="lg"
                className={cn(
                  secondaryVariant === 'destructive' &&
                    'text-destructive hover:bg-destructive/10 hover:text-destructive',
                )}
                onClick={onSecondary}
              >
                {secondaryLabel}
              </Button>
            )}
            <Button
              variant={primary.variant ?? 'success'}
              size="lg"
              disabled={busy}
              onClick={primary.onClick}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                primary.icon
              )}
              {primary.label}
            </Button>
          </div>
        )}
      </div>
      {/* The calm wait line — only on a card with no button (no dead-ends). */}
      {!primary && waitReason && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{waitReason}</span>
        </p>
      )}
      {tracker}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// <StatusTracker> — research Rule 6: a linear ●●○ progress strip.
// ---------------------------------------------------------------------------

export interface StatusTrackerProps {
  /** Everyday-language step labels (e.g. Yuborildi → Tayyorlanmoqda → …). */
  steps: readonly string[];
  /** The 0-based index of the CURRENT step (filled up to and including it). */
  activeIndex: number;
}

/**
 * A calm linear status strip the REQUESTER reads on their own card (research
 * Rule 6) so they never open a board to learn "where is my order". Dots fill
 * up to `activeIndex`; the active dot is emphasised, future dots are muted.
 * Labels are everyday words, never pipeline enum terms.
 */
export function StatusTracker({ steps, activeIndex }: StatusTrackerProps) {
  return (
    <ol className="flex items-center gap-1" aria-label="Holat">
      {steps.map((label, i) => {
        const done = i < activeIndex;
        const active = i === activeIndex;
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-1">
            <span
              aria-hidden="true"
              className={cn(
                'size-2 shrink-0 rounded-full',
                active
                  ? 'bg-primary ring-2 ring-primary/30'
                  : done
                    ? 'bg-primary/60'
                    : 'bg-muted-foreground/25',
              )}
            />
            <span
              className={cn(
                'truncate text-[11px]',
                active
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
            {i < steps.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  'h-px min-w-2 flex-1',
                  done ? 'bg-primary/40' : 'bg-border',
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
