import { CHAIN_LABELS, CHAIN_TONE_BY_TYPE } from '@/lib/chainTokens';
import {
  formatCurrencyCompact,
  formatQty,
  formatRelative,
} from '@/lib/format';
import type {
  ChainPulse,
  ChainSummaryNode,
  LocationType,
} from '@/lib/types';
import type { ChainCardSummary, ChainStat } from './ChainCard';
import type { ChainFlowNode } from './ChainFlowRow';

/**
 * Sprint B — adapter from the backend `chain_summary` shape to the UI
 * `ChainFlowNode[]` used by `ChainFlowRow`.
 *
 * Sprint C (2026-05-25 owner eskiz): each chain layer now exposes a
 * dense 6-10 stat grid (raw/prod/supply: 6 · central: 4 · store: 10).
 * Stat ordering is tuned per the owner's sketch and surfaces the
 * Sprint-C pulse fields (`pending_purchase_orders`, `overdue_orders`,
 * `avg_receipt_today`, etc.). Those fields are optional on the wire —
 * the backend extension lands in parallel — so the adapter applies
 * `0` / `null` defaults to keep the grid robust during the rollout.
 */

const STAGE_ORDER: readonly LocationType[] = [
  'raw_warehouse',
  'production',
  'supply',
  'central_warehouse',
  'store',
] as const;

/** Per-stage "count noun" — what one node of this type is called. */
const COUNT_NOUN: Record<LocationType, string> = {
  raw_warehouse: "bo'g'in",
  production: 'sex',
  supply: 'sklad',
  sex_storage: 'sklad',
  central_warehouse: 'blok',
  store: "do'kon",
};

function belowMinStat(node: ChainSummaryNode): ChainStat {
  return {
    label: "Min'dan past",
    value: String(node.below_min_count),
    tone: node.below_min_count > 0 ? 'danger' : 'default',
  };
}

/**
 * Build the full stat grid per chain type. The grid renders in a 2-col
 * layout (see `ChainCard` — `summary.stats` is variable length).
 *
 * Layout per owner eskiz (2026-05-25):
 *   raw      6 stats  — turlari · min · qabul · chiqim · ochiq PO · jami
 *   prod     6 stats  — faol · bajarildi · overdue · sex · input · output
 *   supply   6 stats  — SKU · min · jo'natildi · qabul · so'rov · dest
 *   central  4 stats  — SKU · min · sinx · 24h xato
 *   store   10 stats  — do'kon · savdo · cheklar · o'rt · SKU · min · ...
 */
function buildStats(node: ChainSummaryNode): ChainStat[] {
  const pulse: ChainPulse = node.pulse;
  const belowMin = belowMinStat(node);

  switch (pulse.kind) {
    case 'raw': {
      // "Sotib olish kerakmi?" — min'dan past · bugun qabul · kutilmoqda
      const pendingPO = pulse.pending_purchase_orders ?? 0;
      return [
        belowMin,
        { label: 'Bugun qabul', value: formatQty(pulse.received_today) },
        {
          label: 'Kutilmoqda',
          value: String(pendingPO),
          tone: pendingPO > 0 ? 'warn' : 'default',
          caption: 'ochiq PO',
        },
      ];
    }
    case 'production': {
      // "Reja bajarilayaptimi?" — muddati o'tgan · faol zayafka · bugun bajarildi
      const overdue = pulse.overdue_orders ?? 0;
      return [
        {
          label: "Muddati o'tgan",
          value: String(overdue),
          tone: overdue > 0 ? 'danger' : 'default',
        },
        { label: 'Faol zayafka', value: formatQty(pulse.active_orders) },
        {
          label: 'Bugun bajarildi',
          value: formatQty(pulse.done_today),
        },
      ];
    }
    case 'supply': {
      // "Biror narsa qotmaganmi?" — ochiq so'rov · jo'natildi · qabul
      const openReq = pulse.open_requests ?? 0;
      return [
        {
          label: "Ochiq so'rov",
          value: String(openReq),
          tone: openReq > 0 ? 'warn' : 'default',
        },
        {
          label: "Bugun jo'natildi",
          value: formatQty(pulse.shipped_today),
        },
        { label: 'Bugun qabul', value: formatQty(pulse.received_today) },
      ];
    }
    case 'central': {
      // "Poster sog'lommi?" — 24h xato · min'dan past · oxirgi sinx
      const syncErrors = pulse.sync_errors_24h ?? 0;
      return [
        {
          label: '24h xato',
          value: String(syncErrors),
          tone: syncErrors > 0 ? 'danger' : 'default',
        },
        belowMin,
        {
          label: 'Oxirgi sinx',
          value:
            pulse.last_sync_at === null
              ? '—'
              : formatRelative(pulse.last_sync_at),
          tone:
            pulse.last_sync_status === 'failed'
              ? 'danger'
              : pulse.last_sync_status === 'partial'
                ? 'warn'
                : pulse.last_sync_status === 'ok'
                  ? 'success'
                  : 'default',
        },
      ];
    }
    case 'store': {
      // "Bugun qancha sotildi?" — savdo (hero) · cheklar · o'rtacha · min'dan past
      return [
        {
          label: 'Bugungi savdo',
          value: formatCurrencyCompact(pulse.sales_today_sum),
          caption: "so'm",
        },
        { label: 'Cheklar', value: formatQty(pulse.receipts_today) },
        {
          label: "O'rtacha chek",
          value: formatCurrencyCompact(pulse.avg_receipt_today ?? 0),
          caption: "so'm",
        },
        belowMin,
      ];
    }
  }
}

function countLabel(node: ChainSummaryNode): string {
  if (node.location_count === 0) return '—';
  return `${formatQty(node.location_count)} ${COUNT_NOUN[node.type]}`;
}

function toFlowNode(node: ChainSummaryNode): ChainFlowNode {
  const tone = CHAIN_TONE_BY_TYPE[node.type];
  const summary: ChainCardSummary = {
    countLabel: countLabel(node),
    status: node.status,
    stats: buildStats(node),
  };
  return {
    type: node.type,
    title: CHAIN_LABELS[tone],
    summary,
  };
}

export function buildChainFlowNodes(
  summary: ChainSummaryNode[],
): ChainFlowNode[] {
  const byType = new Map<LocationType, ChainSummaryNode>();
  for (const row of summary) byType.set(row.type, row);
  return STAGE_ORDER.map((type) => {
    const row = byType.get(type);
    if (row) return toFlowNode(row);
    return emptyFlowNode(type);
  });
}

function emptyFlowNode(type: LocationType): ChainFlowNode {
  const zeroPulse: ChainPulse =
    type === 'raw_warehouse'
      ? {
          kind: 'raw',
          received_today: 0,
          issued_today: 0,
          pending_purchase_orders: 0,
          total_qty_by_unit: [],
        }
      : type === 'production'
        ? {
            kind: 'production',
            active_orders: 0,
            done_today: 0,
            overdue_orders: 0,
            sex_count: 0,
            input_today: 0,
            output_today: 0,
          }
        : type === 'supply'
          ? {
              kind: 'supply',
              shipped_today: 0,
              received_today: 0,
              open_requests: 0,
              top_destination_count: 0,
            }
          : type === 'central_warehouse'
            ? {
                kind: 'central',
                last_sync_at: null,
                last_sync_status: null,
                sync_errors_24h: 0,
              }
            : {
                kind: 'store',
                sales_today_sum: 0,
                receipts_today: 0,
                avg_receipt_today: 0,
                open_replenishments: 0,
                transit_count: 0,
                top_product_name: null,
                qty_today: 0,
              };
  return toFlowNode({
    type,
    location_count: 0,
    total_products: 0,
    below_min_count: 0,
    status: 'ok',
    pulse: zeroPulse,
  });
}
