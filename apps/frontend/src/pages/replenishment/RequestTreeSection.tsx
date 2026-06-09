import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { CornerDownRight, GitBranch, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatQty } from '@/lib/format';
import { pipelineStageOf } from '@/lib/pipeline';
import { PIPELINE_STAGE_LABELS } from '@/lib/labels';
import type { PipelineStage } from '@/lib/types';
import {
  nestRequestTree,
  REQUEST_ORIGIN_LABELS,
  REQUEST_ORIGIN_VARIANT,
  type NestedTreeNode,
  type RequestTreeResponse,
} from '@/lib/replenishmentFlow';

/**
 * "So'rovlar daraxti" — the request-tree section on a request's detail page
 * (cross-department-flow §8). It reads `GET /api/replenishment/:id/tree` and
 * renders the root + children + grandchildren as a nested, indented list with
 * a stage chip, an origin badge, and a "kutuvchilar: N" badge per node, each
 * linking to its own detail page.
 *
 * The endpoint is being built in PARALLEL (F-D) — until it lands a 404 (or any
 * error) MUST degrade gracefully: the section renders NOTHING (returns null) so
 * the detail page is unaffected. A single-node tree (a leaf request with no
 * children and no waiters) is also hidden — there is nothing to show.
 */

/** Per-stage chip variant — mirrors the board column accents. */
const STAGE_VARIANT: Record<
  PipelineStage,
  'warning' | 'info' | 'success' | 'default' | 'secondary'
> = {
  kutuvda: 'warning',
  soralgan: 'info',
  qabul_qilingan: 'success',
  yuborilgan: 'default',
  yopilgan: 'secondary',
};

export function RequestTreeSection({ requestId }: { requestId: string }) {
  const tree = useApiQuery<RequestTreeResponse>(
    `/api/replenishment/${requestId}/tree`,
  );

  const nested = useMemo<NestedTreeNode | null>(
    () => (tree.data ? nestRequestTree(tree.data) : null),
    [tree.data],
  );

  // 404 / any error (endpoint not live yet) → hide the section entirely.
  if (tree.error) return null;

  if (tree.isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>So‘rovlar daraxti</CardTitle>
        </CardHeader>
        <LoadingState />
      </Card>
    );
  }

  if (!nested) return null;

  // A lone leaf (no children, no waiters) carries no tree — nothing to render.
  const hasChildren = nested.children.length > 0;
  const rootWaiters = nested.node.waiters_count ?? 0;
  if (!hasChildren && rootWaiters <= 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="size-4 text-primary" aria-hidden="true" />
          So‘rovlar daraxti
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1">
          <TreeRow node={nested} depth={0} selfId={Number(requestId)} />
        </ul>
      </CardContent>
    </Card>
  );
}

/** One node + its nested children, indented by depth. */
function TreeRow({
  node,
  depth,
  selfId,
}: {
  node: NestedTreeNode;
  depth: number;
  selfId: number;
}) {
  const req = node.node;
  const stage = pipelineStageOf(req);
  const origin = req.origin ?? null;
  const waiters = req.waiters_count ?? 0;
  const isSelf = req.id === selfId;

  return (
    <li>
      <div
        className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40"
        style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
      >
        {depth > 0 && (
          <CornerDownRight
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        {isSelf ? (
          <span className="text-xs font-semibold text-foreground">
            #{req.id}
          </span>
        ) : (
          <Link
            to={`/replenishment/${req.id}`}
            className="text-xs font-semibold text-primary hover:underline"
          >
            #{req.id}
          </Link>
        )}
        <span className="text-sm font-medium">{req.product_name}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatQty(req.qty_needed)} {req.product_unit}
        </span>
        <Badge variant={STAGE_VARIANT[stage]} className="text-[10px]">
          {PIPELINE_STAGE_LABELS[stage]}
        </Badge>
        {origin && (
          <Badge variant={REQUEST_ORIGIN_VARIANT[origin]} className="text-[10px]">
            {REQUEST_ORIGIN_LABELS[origin]}
          </Badge>
        )}
        {waiters > 0 && (
          <Badge variant="outline" className="gap-1 text-[10px] tabular-nums">
            <Users className="size-3" aria-hidden="true" />
            kutuvchilar: {waiters}
          </Badge>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="space-y-1">
          {node.children.map((child) => (
            <TreeRow
              key={child.node.id}
              node={child}
              depth={depth + 1}
              selfId={selfId}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
