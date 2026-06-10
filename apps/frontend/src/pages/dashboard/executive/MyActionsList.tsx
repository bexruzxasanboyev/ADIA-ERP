import { useId } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatQty, formatRelative } from '@/lib/format';
import type {
  PurchaseOrder,
  ReplenishmentRequest,
} from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * F4.7 — "Mendan kutilmoqda" panel for the executive dashboard.
 *
 * Aggregates the boshliq's pending personal queue:
 *   - pending purchase order approvals (`status === 'draft'`)
 *   - new replenishment requests awaiting routing (`status === 'NEW'`)
 *
 * Top 5 are surfaced; the rest is reachable via the footer link.
 */
const TOP_LIMIT = 5;

interface ActionRow {
  key: string;
  label: string;
  sub: string;
  href: string;
  cta: string;
}

function buildRows(
  purchaseOrders: PurchaseOrder[],
  replenishments: ReplenishmentRequest[],
): ActionRow[] {
  const rows: ActionRow[] = [];
  for (const po of purchaseOrders) {
    if (po.status !== 'draft') continue;
    rows.push({
      key: `po-${po.id}`,
      label: `Sotib olish: ${po.product_name}`,
      sub: `${po.target_location_name} · ${formatQty(po.qty)} · ${formatRelative(po.created_at)}`,
      href: '/purchase-orders',
      cta: 'Tasdiqlash',
    });
  }
  for (const r of replenishments) {
    if (r.status !== 'NEW') continue;
    rows.push({
      key: `rep-${r.id}`,
      label: `Yangi so‘rov: ${r.product_name}`,
      sub: `${r.requester_location_name} · ${formatQty(r.qty_needed)} · ${formatRelative(r.created_at)}`,
      href: `/replenishment/${r.id}`,
      cta: 'Ko‘rib chiqish',
    });
  }
  return rows;
}

export function MyActionsList({
  purchaseOrders,
  replenishments,
  className,
}: {
  purchaseOrders: PurchaseOrder[];
  replenishments: ReplenishmentRequest[];
  className?: string;
}) {
  const rows = buildRows(purchaseOrders, replenishments);
  const top = rows.slice(0, TOP_LIMIT);
  const overflow = rows.length - top.length;
  const headingId = useId();

  return (
    <Card
      className={cn('flex flex-col', className)}
      data-testid="my-actions-list"
      role="region"
      aria-labelledby={headingId}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2
            id={headingId}
            className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            <ClipboardList
              className="size-4 text-primary"
              aria-hidden="true"
            />
            Mendan kutilmoqda
          </h2>
          <p className="text-xs text-muted-foreground">
            Tasdiq talab qiluvchi so‘rovlar.
          </p>
        </div>
        {rows.length > 0 && (
          <Badge variant="secondary" className="tabular-nums">
            {formatQty(rows.length)}
          </Badge>
        )}
      </header>

      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Hozirda harakat talab qilinmaydi.
          </p>
        </div>
      ) : (
        <ol className="flex-1 divide-y divide-border/60">
          {top.map((row) => (
            <li key={row.key} className="px-5 py-3">
              <Link
                to={row.href}
                className="group flex items-start gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <span
                  aria-hidden="true"
                  className="mt-1.5 inline-flex size-2 shrink-0 rounded-full bg-primary"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground group-hover:text-primary">
                    {row.label}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.sub}
                  </p>
                </div>
                <span className="shrink-0 text-xs font-medium text-primary opacity-0 transition group-hover:opacity-100">
                  {row.cta} →
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}

      {overflow > 0 && (
        <footer className="border-t border-border/60 px-5 py-3 text-center text-xs">
          <Link
            to="/purchase-orders"
            className="font-medium text-primary hover:underline"
          >
            Yana {formatQty(overflow)} ta →
          </Link>
        </footer>
      )}
    </Card>
  );
}
