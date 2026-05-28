/**
 * ecosystemAdapter — pure transform contract tests.
 *
 * The adapter is the load-bearing part of `EcosystemCanvas` — it turns
 * `chain_flow[]` (per-location rows) and `suppliers[]` (top-5) into
 * React Flow `nodes[]` + `edges[]`. We assert:
 *   • one node is emitted per upstream row (suppliers + each location);
 *   • node ids follow stable prefixed conventions;
 *   • status is derived from `below_min_count` (0 → ok, 1-3 → warn, 4+ → danger);
 *   • edges connect suppliers → raw → production → supply → central → store
 *     in the expected fan-out direction.
 */
import { describe, expect, it } from 'vitest';
import { buildEcosystemGraph } from './ecosystemAdapter';
import type {
  DashboardChainNode,
  DashboardSuppliersResponse,
} from '@/lib/types';

const SUPPLIERS: DashboardSuppliersResponse['suppliers'] = [
  {
    supplier_id: 11,
    supplier_name: 'Don Mahsulot',
    pending_pos: 3,
    total_pos: 10,
    received_qty: 700,
    expected_qty: 300,
    status: 'warn',
  },
  {
    supplier_id: 12,
    supplier_name: 'Sut Tarmoq',
    pending_pos: 0,
    total_pos: 5,
    received_qty: 500,
    expected_qty: 0,
    status: 'ok',
  },
];

const CHAIN_FLOW: DashboardChainNode[] = [
  {
    location_id: 1,
    location_name: 'Xom-ashyo ombori',
    location_type: 'raw_warehouse',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 12,
  },
  {
    location_id: 2,
    location_name: 'Sex Tort',
    location_type: 'production',
    below_min_count: 0,
    open_requests_count: 1,
    total_products: 8,
  },
  {
    location_id: 3,
    location_name: 'Sex Perojniy',
    location_type: 'production',
    below_min_count: 5,
    open_requests_count: 2,
    total_products: 6,
  },
  {
    location_id: 4,
    location_name: "Tort sklad",
    location_type: 'supply',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 5,
  },
  {
    location_id: 5,
    location_name: 'Perojniy sklad',
    location_type: 'supply',
    below_min_count: 2,
    open_requests_count: 0,
    total_products: 7,
  },
  {
    location_id: 6,
    location_name: 'Markaziy sklad',
    location_type: 'central_warehouse',
    below_min_count: 1,
    open_requests_count: 0,
    total_products: 25,
  },
  {
    location_id: 7,
    location_name: 'Кукча',
    location_type: 'store',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 18,
  },
  {
    location_id: 8,
    location_name: 'Рабочий',
    location_type: 'store',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 18,
  },
  // The bakery has these stores in Poster but they are not operational
  // any more — the adapter must filter them out before they reach the
  // canvas. We keep two non-allowlisted entries here on purpose so the
  // filter contract is exercised by every edge / count assertion.
  {
    location_id: 9,
    location_name: "Do'kon Chilonzor",
    location_type: 'store',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 18,
  },
  {
    location_id: 10,
    location_name: "Do'kon Yunusobod",
    location_type: 'store',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 18,
  },
];

describe('buildEcosystemGraph', () => {
  it('emits one node per supplier, per allowlisted chain-flow row, and the production group parent', () => {
    const { nodes } = buildEcosystemGraph({
      chainFlow: CHAIN_FLOW,
      suppliers: SUPPLIERS,
    });

    // Non-store rows: raw + production + supply + central — all kept.
    // Stores: only those whose normalised name is in the allowlist
    //         (Кукча + Рабочий + their Latin variants).
    // Plus the synthetic production-group parent node = +1.
    const nonStoreRows = CHAIN_FLOW.filter(
      (r) => r.location_type !== 'store',
    ).length;
    const activeStoreRows = CHAIN_FLOW.filter(
      (r) =>
        r.location_type === 'store' &&
        ['кукча', 'рабочий', 'kukcha', 'kokcha', 'rabochiy'].includes(
          r.location_name.trim().toLowerCase(),
        ),
    ).length;
    expect(nodes).toHaveLength(
      SUPPLIERS.length + nonStoreRows + activeStoreRows + 1,
    );

    // The production group is always present when there is at least
    // one sex row.
    expect(nodes.find((n) => n.id === 'production-group')).toBeDefined();
  });

  it('places sex nodes as children of the production group', () => {
    const { nodes } = buildEcosystemGraph({
      chainFlow: CHAIN_FLOW,
      suppliers: [],
    });

    const sex = nodes.find((n) => n.id === 'loc-2');
    expect(sex).toBeDefined();
    expect(sex?.parentNode).toBe('production-group');
    expect(sex?.extent).toBe('parent');
  });

  it('keeps only Кукча + Рабочий stores (exact-name allowlist)', () => {
    const { nodes } = buildEcosystemGraph({
      chainFlow: [
        ...CHAIN_FLOW.filter((r) => r.location_type !== 'store'),
        {
          location_id: 60,
          location_name: 'Кукча',
          location_type: 'store',
          below_min_count: 0,
          open_requests_count: 0,
          total_products: 12,
        },
        {
          location_id: 61,
          location_name: 'Рабочий',
          location_type: 'store',
          below_min_count: 0,
          open_requests_count: 0,
          total_products: 8,
        },
        {
          location_id: 62,
          location_name: 'Кукча центральный',
          location_type: 'store',
          below_min_count: 0,
          open_requests_count: 0,
          total_products: 5,
        },
        {
          location_id: 63,
          location_name: 'Чигатай',
          location_type: 'store',
          below_min_count: 0,
          open_requests_count: 0,
          total_products: 3,
        },
      ],
      suppliers: [],
    });

    const ids = new Set(nodes.map((n) => n.id));
    // Kept
    expect(ids.has('loc-60')).toBe(true); // Кукча
    expect(ids.has('loc-61')).toBe(true); // Рабочий
    // Dropped — substring "кукча" is not enough; exact normalised match required.
    expect(ids.has('loc-62')).toBe(false); // Кукча центральный
    expect(ids.has('loc-63')).toBe(false); // Чигатай
  });

  it('uses stable prefixed ids for nodes', () => {
    const { nodes } = buildEcosystemGraph({
      chainFlow: CHAIN_FLOW,
      suppliers: SUPPLIERS,
    });

    const ids = new Set(nodes.map((n) => n.id));
    expect(ids.has('supplier-11')).toBe(true);
    expect(ids.has('supplier-12')).toBe(true);
    expect(ids.has('loc-1')).toBe(true);
    expect(ids.has('loc-7')).toBe(true);
  });

  it('falls back to "unknown" supplier id when supplier_id is null', () => {
    const { nodes } = buildEcosystemGraph({
      chainFlow: CHAIN_FLOW,
      suppliers: [
        {
          supplier_id: null,
          supplier_name: "Noma'lum",
          pending_pos: 0,
          total_pos: 0,
          received_qty: 0,
          expected_qty: 0,
          status: 'ok',
        },
      ],
    });

    expect(nodes.some((n) => n.id === 'supplier-unknown')).toBe(true);
  });

  it('derives node status from below_min_count', () => {
    const { nodes } = buildEcosystemGraph({
      chainFlow: CHAIN_FLOW,
      suppliers: [],
    });

    const byId = new Map(nodes.map((n) => [n.id, n]));
    // location 3 has below_min=5 → danger
    expect(byId.get('loc-3')?.data).toMatchObject({ status: 'danger' });
    // location 5 has below_min=2 → warn
    expect(byId.get('loc-5')?.data).toMatchObject({ status: 'warn' });
    // location 1 has below_min=0 → ok
    expect(byId.get('loc-1')?.data).toMatchObject({ status: 'ok' });
  });

  it('connects every supplier to the (first) raw warehouse', () => {
    const { edges } = buildEcosystemGraph({
      chainFlow: CHAIN_FLOW,
      suppliers: SUPPLIERS,
    });

    expect(
      edges.find(
        (e) => e.source === 'supplier-11' && e.target === 'loc-1',
      ),
    ).toBeDefined();
    expect(
      edges.find(
        (e) => e.source === 'supplier-12' && e.target === 'loc-1',
      ),
    ).toBeDefined();
  });

  it('fans the raw warehouse out to each production sex with a sex-name label', () => {
    const { edges } = buildEcosystemGraph({
      chainFlow: CHAIN_FLOW,
      suppliers: SUPPLIERS,
    });

    // Raw (loc-1) → each sex child (loc-2 Tort, loc-3 Perojniy) so the
    // owner can read which sex consumes what at a glance.
    const toTort = edges.find(
      (e) => e.source === 'loc-1' && e.target === 'loc-2',
    );
    const toPerojniy = edges.find(
      (e) => e.source === 'loc-1' && e.target === 'loc-3',
    );
    expect(toTort).toBeDefined();
    expect(toPerojniy).toBeDefined();
    // The umbrella production-group node receives no incoming edge any
    // more — edges target the individual sex children directly.
    expect(
      edges.find(
        (e) => e.source === 'loc-1' && e.target === 'production-group',
      ),
    ).toBeUndefined();
    // Labels strip the trailing "sexi" / "Sex" prefix down to the
    // product tag so the canvas stays scannable.
    expect(toTort?.label).toBe('Tort');
    expect(toPerojniy?.label).toBe('Perojniy');
  });

  it('routes production → supply by closest-name match', () => {
    const { edges } = buildEcosystemGraph({
      chainFlow: CHAIN_FLOW,
      suppliers: [],
    });

    // Sex Tort (loc 2) should funnel into Tort sklad (loc 4)
    expect(
      edges.find((e) => e.source === 'loc-2' && e.target === 'loc-4'),
    ).toBeDefined();
    // Sex Perojniy (loc 3) → Perojniy sklad (loc 5)
    expect(
      edges.find((e) => e.source === 'loc-3' && e.target === 'loc-5'),
    ).toBeDefined();
    // …and NOT cross-wired
    expect(
      edges.find((e) => e.source === 'loc-2' && e.target === 'loc-5'),
    ).toBeUndefined();
  });

  it('connects the central warehouse to every allowlisted store', () => {
    const { edges } = buildEcosystemGraph({
      chainFlow: CHAIN_FLOW,
      suppliers: [],
    });

    // Kept: Kukcha (loc-7) + Rabochiy (loc-8)
    expect(
      edges.find((e) => e.source === 'loc-6' && e.target === 'loc-7'),
    ).toBeDefined();
    expect(
      edges.find((e) => e.source === 'loc-6' && e.target === 'loc-8'),
    ).toBeDefined();
    // Filtered: Chilonzor (loc-9), Yunusobod (loc-10) must NOT have edges.
    expect(edges.find((e) => e.target === 'loc-9')).toBeUndefined();
    expect(edges.find((e) => e.target === 'loc-10')).toBeUndefined();
  });

  it('caps suppliers at the top 5', () => {
    const many: DashboardSuppliersResponse['suppliers'] = Array.from(
      { length: 8 },
      (_, i) => ({
        supplier_id: 100 + i,
        supplier_name: `Supplier ${i}`,
        pending_pos: 0,
        total_pos: 0,
        received_qty: 0,
        expected_qty: 0,
        status: 'ok',
      }),
    );

    const { nodes } = buildEcosystemGraph({
      chainFlow: CHAIN_FLOW,
      suppliers: many,
    });

    const supplierNodes = nodes.filter((n) => n.id.startsWith('supplier-'));
    expect(supplierNodes).toHaveLength(5);
  });

  it('returns an empty graph when both inputs are empty', () => {
    const { nodes, edges } = buildEcosystemGraph({
      chainFlow: [],
      suppliers: [],
    });

    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('emits zero production→supply edges for a sex whose name matches no supply', () => {
    // "Sex Konfet" shares no tokens with "Tort sklad" / "Perojniy sklad".
    // The old adapter fanned the sex out to *every* supply, producing a
    // confusing hairball. The new contract: no match → no edges.
    const chain: DashboardChainNode[] = [
      {
        location_id: 1,
        location_name: 'Xom-ashyo ombori',
        location_type: 'raw_warehouse',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 10,
      },
      {
        location_id: 20,
        location_name: 'Sex Konfet',
        location_type: 'production',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 4,
      },
      {
        location_id: 30,
        location_name: 'Tort sklad',
        location_type: 'supply',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 5,
      },
      {
        location_id: 31,
        location_name: 'Perojniy sklad',
        location_type: 'supply',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 5,
      },
    ];

    const { edges } = buildEcosystemGraph({
      chainFlow: chain,
      suppliers: [],
    });

    const fromSex = edges.filter((e) => e.source === 'loc-20');
    expect(fromSex).toHaveLength(0);
  });

  it('hides the umbrella "Ishlab chiqarish sexi" parent from the production layer', () => {
    const chain: DashboardChainNode[] = [
      {
        location_id: 1,
        location_name: 'Xom-ashyo ombori',
        location_type: 'raw_warehouse',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 10,
      },
      {
        location_id: 21,
        location_name: 'Ishlab chiqarish sexi',
        location_type: 'production',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 8,
      },
      {
        location_id: 22,
        location_name: 'Tort sexi',
        location_type: 'production',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 4,
      },
      {
        location_id: 40,
        location_name: "Ta'minot — Tort",
        location_type: 'supply',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 5,
      },
    ];

    const { nodes, edges } = buildEcosystemGraph({
      chainFlow: chain,
      suppliers: [],
    });

    // Umbrella parent node is gone; only the product-specific sex remains.
    expect(nodes.find((n) => n.id === 'loc-21')).toBeUndefined();
    expect(nodes.find((n) => n.id === 'loc-22')).toBeDefined();
    // No edge originates from the hidden umbrella.
    expect(edges.filter((e) => e.source === 'loc-21')).toHaveLength(0);
    // Tort sexi still routes to its name-matched supply.
    const fromTort = edges.filter((e) => e.source === 'loc-22');
    expect(fromTort).toHaveLength(1);
    expect(fromTort[0]?.target).toBe('loc-40');
  });

  it('renders semantic production KPIs (Faol / Bugun) on sex nodes', () => {
    // A sex is a conversion point — SKU/MIN/SO'ROV always read 0/0/0 there
    // and convey nothing. The adapter must switch to FAOL / BUGUN for
    // `production` rows using the backend-provided counters.
    const chain: DashboardChainNode[] = [
      {
        location_id: 1,
        location_name: 'Xom-ashyo ombori',
        location_type: 'raw_warehouse',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 12,
        active_production_orders: null,
        done_today_count: null,
      },
      {
        location_id: 22,
        location_name: 'Tort sexi',
        location_type: 'production',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 0,
        active_production_orders: 4,
        done_today_count: 2,
      },
      {
        location_id: 23,
        location_name: 'Perojniy sexi',
        location_type: 'production',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 0,
        // Server can send `null` even for production rows on a fresh
        // bootstrap — the adapter must coalesce to `0`, never NaN.
        active_production_orders: null,
        done_today_count: null,
      },
    ];

    const { nodes } = buildEcosystemGraph({ chainFlow: chain, suppliers: [] });
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const tortData = byId.get('loc-22')?.data as {
      stats: Array<{ label: string; value: string }>;
    };
    expect(tortData.stats.map((s) => s.label)).toEqual(['Faol', 'Bugun']);
    expect(tortData.stats[0]?.value).toBe('4');
    expect(tortData.stats[1]?.value).toBe('2');

    const perojData = byId.get('loc-23')?.data as {
      stats: Array<{ label: string; value: string }>;
    };
    expect(perojData.stats.map((s) => s.value)).toEqual(['0', '0']);

    // Non-production rows keep the legacy SKU/Min/So'rov trio.
    const rawData = byId.get('loc-1')?.data as {
      stats: Array<{ label: string; value: string }>;
    };
    expect(rawData.stats.map((s) => s.label)).toEqual(['SKU', 'Min', "So'rov"]);
  });

  it("labels each production→supply edge with the supply's product tag", () => {
    const chain: DashboardChainNode[] = [
      {
        location_id: 1,
        location_name: 'Xom-ashyo ombori',
        location_type: 'raw_warehouse',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 10,
      },
      {
        location_id: 22,
        location_name: 'Tort sexi',
        location_type: 'production',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 6,
      },
      {
        location_id: 23,
        location_name: 'Perojniy sexi',
        location_type: 'production',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 4,
      },
      {
        location_id: 50,
        location_name: "Ta'minot — Tort",
        location_type: 'supply',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 5,
      },
      {
        location_id: 51,
        location_name: "Ta'minot — Perojniy",
        location_type: 'supply',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 5,
      },
    ];

    const { edges } = buildEcosystemGraph({
      chainFlow: chain,
      suppliers: [],
    });

    const tortEdge = edges.find(
      (e) => e.source === 'loc-22' && e.target === 'loc-50',
    );
    const perojniyEdge = edges.find(
      (e) => e.source === 'loc-23' && e.target === 'loc-51',
    );
    expect(tortEdge?.label).toBe('Tort');
    expect(perojniyEdge?.label).toBe('Perojniy');
  });

  it('coalesces sex_storage rows onto the supply bucket (ENUM migration)', () => {
    // Backend ENUM migration — rows arriving as `sex_storage` must be
    // placed on the canvas exactly like legacy `supply` rows so the
    // ecosystem layout does not regress during the rollout. The adapter
    // emits `loc-<id>` nodes regardless of which ENUM value the wire
    // carried.
    const chain: DashboardChainNode[] = [
      {
        location_id: 1,
        location_name: 'Xom-ashyo ombori',
        location_type: 'raw_warehouse',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 1,
      },
      {
        location_id: 41,
        location_name: 'Tort skladi',
        location_type: 'sex_storage',
        below_min_count: 0,
        open_requests_count: 0,
        total_products: 4,
      },
      {
        location_id: 42,
        location_name: 'Yarim Fabrika skladi',
        location_type: 'sex_storage',
        below_min_count: 2,
        open_requests_count: 1,
        total_products: 7,
      },
    ];

    const { nodes } = buildEcosystemGraph({
      chainFlow: chain,
      suppliers: [],
    });

    expect(nodes.find((n) => n.id === 'loc-41')).toBeDefined();
    expect(nodes.find((n) => n.id === 'loc-42')).toBeDefined();
  });
});
