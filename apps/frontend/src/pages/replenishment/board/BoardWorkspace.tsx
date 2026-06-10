import { useState, type ReactNode } from 'react';
import { Tabs } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { RequestKanban } from './RequestKanban';
import type { FlowRequest } from '@/lib/replenishmentFlow';

/**
 * The ONE-board workspace shared by every So'rovlar surface (central /
 * production / store). Owner feedback ("dublicate doska bo'lib qolyabdi"): the
 * old 📥 Kelgan and 📤 Chiqgan boards rendered STACKED — two near-identical
 * column sets that read as a duplicate. This collapses them into a SINGLE board
 * area under a compact segmented "📥 Kelgan (N) | 📤 Chiqgan (M)" toggle (counts
 * baked into the labels), the active side's {@link RequestKanban} below it.
 *
 * The board runs in `fill` mode at a consistent in-workspace height so every
 * page's board feels the same (Jira-style: each column scrolls its own cards
 * under a fixed header). All per-card actions / modal wiring is passed straight
 * through to `RequestKanban` — this component owns only the toggle + framing.
 *
 * `defaultSide` differs by role: central/production default to `incoming`
 * (they are mostly suppliers acting on Kelgan), stores default to `outgoing`
 * (they mostly request; Kelgan may be empty).
 */

export type BoardSide = 'incoming' | 'outgoing';

export interface BoardWorkspaceProps {
  /** 📥 Kelgan rows (I am the supplier — target ∈ my scope). */
  incoming: FlowRequest[];
  /** 📤 Chiqgan rows (I am the customer — requester ∈ my scope). */
  outgoing: FlowRequest[];
  /** Which side is shown first. central/production → incoming; store → outgoing. */
  defaultSide?: BoardSide;
  /** Per-card click → open the shared RequestDetailModal. */
  onOpen?: (req: FlowRequest) => void;
  /** Per-card trailing action on the 📥 Kelgan board only (e.g. "Manba reja"). */
  renderIncomingAction?: (req: FlowRequest) => ReactNode;
  /** Per-card trailing action on the 📤 Chiqgan board only (rare). */
  renderOutgoingAction?: (req: FlowRequest) => ReactNode;
  /** Empty-column copy for the 📥 Kelgan board. */
  incomingEmptyLabel?: string;
  /** Empty-column copy for the 📤 Chiqgan board. */
  outgoingEmptyLabel?: string;
  /**
   * Tailwind height for the board area. Defaults to a generous in-workspace
   * height (NOT full-viewport — these boards live inside a scrolling workspace
   * with charts above them, unlike the dedicated /replenishment Doska).
   */
  heightClassName?: string;
  /**
   * F-M action-ownership signal: the viewer's own location ids. When given,
   * every card states whose move it waits on — "Harakat sizda" on the viewer's
   * cards, a dimmed "… kutilmoqda" naming the other side elsewhere. This is
   * what makes the central and store boards read DIFFERENTLY for the same
   * request (owner: "doskalar bir xil ma'lumot ko'rsatyapti").
   */
  actionScope?: ReadonlySet<number>;
}

export function BoardWorkspace({
  incoming,
  outgoing,
  defaultSide = 'incoming',
  onOpen,
  renderIncomingAction,
  renderOutgoingAction,
  incomingEmptyLabel = 'Kelgan so‘rov yo‘q.',
  outgoingEmptyLabel = 'Chiqgan so‘rov yo‘q.',
  heightClassName = 'h-[clamp(28rem,calc(100dvh-30rem),60rem)]',
  actionScope,
}: BoardWorkspaceProps) {
  const [side, setSide] = useState<BoardSide>(defaultSide);

  const sideOptions: { value: BoardSide; label: string }[] = [
    { value: 'incoming', label: `📥 Kelgan · ${incoming.length}` },
    { value: 'outgoing', label: `📤 Chiqgan · ${outgoing.length}` },
  ];

  const active = side === 'incoming' ? incoming : outgoing;
  const renderAction =
    side === 'incoming' ? renderIncomingAction : renderOutgoingAction;
  const emptyLabel =
    side === 'incoming' ? incomingEmptyLabel : outgoingEmptyLabel;

  return (
    <div className="space-y-3">
      {/* Segmented Kelgan | Chiqgan toggle (counts in labels) — left-aligned,
          own row, DESIGN.md §9. */}
      <Tabs
        value={side}
        onValueChange={setSide}
        options={sideOptions}
        ariaLabel="Doska tomoni"
      />
      <div className={cn('min-h-0', heightClassName)}>
        <RequestKanban
          fill
          requests={active}
          renderAction={renderAction}
          onOpen={onOpen}
          emptyLabel={emptyLabel}
          viewer={
            actionScope !== undefined ? { side, scope: actionScope } : undefined
          }
        />
      </div>
    </div>
  );
}
