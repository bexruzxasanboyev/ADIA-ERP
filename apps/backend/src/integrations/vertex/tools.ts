/**
 * AI assistant tool layer (ADR-0006 §2, spec §3).
 *
 * Six READ-ONLY tools the Gemini model is allowed to call. Each tool is a
 * pair of:
 *   - `declaration` — a Gemini `FunctionDeclaration` (advertised to the
 *     model so it can decide when to call it);
 *   - `execute(args, principal)` — the server-side executor. Args are
 *     validated, RBAC is applied server-side (the model has no influence
 *     over scope — see ADR-0006 §3), and a parameterised SQL query runs.
 *
 * Invariants (Phase-2 Faza-2):
 *   1. NO writes — every SQL is SELECT. INSERT/UPDATE/DELETE are absent.
 *   2. RBAC scope is computed from `principal`, not from `args`. A
 *      `store_manager` cannot read another store by passing `location_id`
 *      — the executor overrides the value.
 *   3. Every result is row-limited (LIMIT 200 / max-100 client cap) so a
 *      large table cannot blow the LLM context window.
 */
import { FunctionDeclarationSchemaType, type FunctionDeclaration } from '@google-cloud/vertexai';
import type { AuthPrincipal } from '../../auth/jwt.js';
import { query, type SqlParam } from '../../db/index.js';

// ---------------------------------------------------------------------------
// Tool registry types
// ---------------------------------------------------------------------------

/** JSON-clean tool result — a list of homogeneous rows. */
export type ToolRow = Record<string, string | number | boolean | null>;

export type ToolExecutor = {
  readonly declaration: FunctionDeclaration;
  execute(args: Record<string, unknown>, principal: AuthPrincipal): Promise<ToolRow[]>;
};

/** Names of every advertised tool. Closed list — model picks from it. */
export const TOOL_NAMES = [
  'get_stock',
  'get_open_requests',
  'get_production_plan',
  'get_below_min',
  'get_recent_movements',
  'get_sales_summary',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A principal that is allowed to see the whole chain (pm or ai_assistant). */
function isChainWide(principal: AuthPrincipal): boolean {
  return principal.role === 'pm' || principal.role === 'ai_assistant';
}

/**
 * Resolve the location_id filter for a tool call. Chain-wide principals may
 * pass `location_id` freely (or omit it for "all"); a scoped manager is
 * ALWAYS pinned to their own location, regardless of `args.location_id`.
 *
 * If a scoped principal has no location attached to their JWT, return
 * `'empty'` — the tool returns an empty array instead of leaking unrelated
 * rows.
 */
function resolveLocationScope(
  principal: AuthPrincipal,
  argLocation: unknown,
): { kind: 'all' } | { kind: 'one'; locationId: number } | { kind: 'empty' } {
  if (isChainWide(principal)) {
    const parsed = parseOptionalId(argLocation);
    return parsed === null ? { kind: 'all' } : { kind: 'one', locationId: parsed };
  }
  if (principal.locationId === null) {
    return { kind: 'empty' };
  }
  return { kind: 'one', locationId: principal.locationId };
}

/** Best-effort coercion of an LLM-supplied id; returns null when missing/invalid. */
function parseOptionalId(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Bound a user-supplied limit (defaults to 20, max 100, fallback 200 for "all"). */
function clampLimit(value: unknown, defaultLimit: number, maxLimit: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return defaultLimit;
  }
  return Math.min(Math.floor(n), maxLimit);
}

/** Parse an ISO date or `YYYY-MM-DD` string into the same string (validated). */
function parseOptionalDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Coerce pg NUMERIC strings into JS numbers across a row. */
function numerify(row: Record<string, unknown>): ToolRow {
  const out: ToolRow = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) {
      out[k] = null;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (v instanceof Date) {
      out[k] = v.toISOString();
    } else if (typeof v === 'string') {
      // pg returns BIGINT and NUMERIC as strings — convert when it looks numeric.
      const trimmed = v.trim();
      if (/^-?\d+$/.test(trimmed)) {
        const n = Number(trimmed);
        out[k] = Number.isSafeInteger(n) ? n : trimmed;
      } else if (/^-?\d+\.\d+$/.test(trimmed)) {
        out[k] = Number(trimmed);
      } else {
        out[k] = trimmed;
      }
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. get_stock
// ---------------------------------------------------------------------------

const getStock: ToolExecutor = {
  declaration: {
    name: 'get_stock',
    description:
      'Returns current stock levels (qty, min, max, below_min) for products at locations. ' +
      'Use when the user asks about on-hand quantity, min/max thresholds, or whether ' +
      'something is below min. RBAC is enforced server-side — a non-PM caller always sees ' +
      'only their own location regardless of `location_id`.',
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        location_id: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: 'Optional location id. Ignored for non-PM callers (pinned to their own).',
        },
        product_id: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: 'Optional product id; omit for all products.',
        },
        only_below_min: {
          type: FunctionDeclarationSchemaType.BOOLEAN,
          description: 'When true, only rows where qty <= min_level.',
        },
      },
    },
  },
  async execute(args, principal): Promise<ToolRow[]> {
    const scope = resolveLocationScope(principal, args.location_id);
    if (scope.kind === 'empty') {
      return [];
    }
    const productId = parseOptionalId(args.product_id);
    const onlyBelowMin = args.only_below_min === true;

    const params: SqlParam[] = [];
    const conditions: string[] = [];
    if (scope.kind === 'one') {
      params.push(scope.locationId);
      conditions.push(`s.location_id = $${params.length}`);
    }
    if (productId !== null) {
      params.push(productId);
      conditions.push(`s.product_id = $${params.length}`);
    }
    if (onlyBelowMin) {
      conditions.push('s.qty <= s.min_level');
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

    const { rows } = await query<Record<string, unknown>>(
      `SELECT s.location_id, l.name AS location_name,
              s.product_id, p.name AS product_name, p.unit AS product_unit,
              s.qty, s.min_level, s.max_level, s.minmax_mode,
              (s.qty <= s.min_level) AS below_min
         FROM stock s
         JOIN locations l ON l.id = s.location_id
         JOIN products  p ON p.id = s.product_id
         ${where}
         ORDER BY l.name, p.name
         LIMIT 200`,
      params,
    );
    return rows.map(numerify);
  },
};

// ---------------------------------------------------------------------------
// 2. get_open_requests
// ---------------------------------------------------------------------------

const OPEN_REPL_STATUSES = ['NEW', 'CHECK_STORE_SUPPLIER', 'SHIP_TO_REQUESTER',
  'CHECK_PRODUCTION_INPUT', 'CREATE_PURCHASE_ORDER', 'CREATE_PRODUCTION_ORDER',
  'PRODUCING', 'DONE_TO_WAREHOUSE'] as const;

const getOpenRequests: ToolExecutor = {
  declaration: {
    name: 'get_open_requests',
    description:
      'Lists open replenishment requests (status not CLOSED/CANCELLED). Optionally filter ' +
      'by a specific status. Non-PM callers see only requests where their location is the ' +
      'requester or the target.',
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        status: {
          type: FunctionDeclarationSchemaType.STRING,
          description:
            'Optional replenishment status filter. One of: NEW, CHECK_STORE_SUPPLIER, ' +
            'SHIP_TO_REQUESTER, CHECK_PRODUCTION_INPUT, CREATE_PURCHASE_ORDER, ' +
            'CREATE_PRODUCTION_ORDER, PRODUCING, DONE_TO_WAREHOUSE.',
        },
        location_id: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: 'Optional location id (ignored for non-PM callers).',
        },
      },
    },
  },
  async execute(args, principal): Promise<ToolRow[]> {
    const scope = resolveLocationScope(principal, args.location_id);
    if (scope.kind === 'empty') {
      return [];
    }
    const params: SqlParam[] = [];
    const conditions: string[] = [
      `r.status NOT IN ('CLOSED','CANCELLED')`,
    ];
    if (scope.kind === 'one') {
      params.push(scope.locationId);
      conditions.push(
        `(r.requester_location_id = $${params.length} OR r.target_location_id = $${params.length})`,
      );
    }
    if (typeof args.status === 'string') {
      const s = args.status.trim().toUpperCase();
      if ((OPEN_REPL_STATUSES as readonly string[]).includes(s)) {
        params.push(s);
        conditions.push(`r.status::text = $${params.length}`);
      }
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const { rows } = await query<Record<string, unknown>>(
      `SELECT r.id, r.product_id, p.name AS product_name,
              r.requester_location_id, rl.name AS requester_location_name,
              r.target_location_id,    tl.name AS target_location_name,
              r.qty_needed, r.status::text AS status, r.created_at
         FROM replenishment_requests r
         JOIN products  p  ON p.id = r.product_id
         JOIN locations rl ON rl.id = r.requester_location_id
         LEFT JOIN locations tl ON tl.id = r.target_location_id
         ${where}
         ORDER BY r.created_at DESC
         LIMIT 100`,
      params,
    );
    return rows.map(numerify);
  },
};

// ---------------------------------------------------------------------------
// 3. get_production_plan
// ---------------------------------------------------------------------------

const PRODUCTION_STATUSES = ['new', 'in_progress', 'done', 'cancelled'] as const;

const getProductionPlan: ToolExecutor = {
  declaration: {
    name: 'get_production_plan',
    description:
      'Returns production orders (zayafkalar) optionally filtered by deadline range or status. ' +
      'Non-PM callers see only orders produced at or targeting their location.',
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        date_from: {
          type: FunctionDeclarationSchemaType.STRING,
          description: 'Optional ISO date (YYYY-MM-DD). Filters deadline >= date_from.',
        },
        date_to: {
          type: FunctionDeclarationSchemaType.STRING,
          description: 'Optional ISO date (YYYY-MM-DD). Filters deadline <= date_to.',
        },
        status: {
          type: FunctionDeclarationSchemaType.STRING,
          description: 'Optional production_order_status (new, in_progress, done, cancelled).',
        },
      },
    },
  },
  async execute(args, principal): Promise<ToolRow[]> {
    const scope = resolveLocationScope(principal, undefined);
    if (scope.kind === 'empty') {
      return [];
    }
    const params: SqlParam[] = [];
    const conditions: string[] = [];
    if (scope.kind === 'one') {
      params.push(scope.locationId);
      conditions.push(
        `(po.location_id = $${params.length} OR po.target_location_id = $${params.length})`,
      );
    }
    const dateFrom = parseOptionalDate(args.date_from);
    if (dateFrom !== null) {
      params.push(dateFrom);
      conditions.push(`po.deadline >= $${params.length}::date`);
    }
    const dateTo = parseOptionalDate(args.date_to);
    if (dateTo !== null) {
      params.push(dateTo);
      conditions.push(`po.deadline <= $${params.length}::date`);
    }
    if (typeof args.status === 'string') {
      const s = args.status.trim().toLowerCase();
      if ((PRODUCTION_STATUSES as readonly string[]).includes(s)) {
        params.push(s);
        conditions.push(`po.status::text = $${params.length}`);
      }
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const { rows } = await query<Record<string, unknown>>(
      `SELECT po.id, po.product_id, p.name AS product_name,
              po.qty, po.status::text AS status,
              po.location_id, l.name AS location_name,
              po.target_location_id, tl.name AS target_location_name,
              po.deadline, po.created_at
         FROM production_orders po
         JOIN products  p  ON p.id = po.product_id
         JOIN locations l  ON l.id = po.location_id
         LEFT JOIN locations tl ON tl.id = po.target_location_id
         ${where}
         ORDER BY po.deadline NULLS LAST, po.id
         LIMIT 100`,
      params,
    );
    return rows.map(numerify);
  },
};

// ---------------------------------------------------------------------------
// 4. get_below_min
// ---------------------------------------------------------------------------

const getBelowMin: ToolExecutor = {
  declaration: {
    name: 'get_below_min',
    description:
      'Returns rows where stock.qty <= min_level — the red list of products that need ' +
      'replenishment. RBAC scoped server-side.',
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        location_id: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: 'Optional location id (ignored for non-PM callers).',
        },
      },
    },
  },
  async execute(args, principal): Promise<ToolRow[]> {
    const scope = resolveLocationScope(principal, args.location_id);
    if (scope.kind === 'empty') {
      return [];
    }
    const params: SqlParam[] = [];
    const conditions: string[] = ['s.qty <= s.min_level'];
    if (scope.kind === 'one') {
      params.push(scope.locationId);
      conditions.push(`s.location_id = $${params.length}`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const { rows } = await query<Record<string, unknown>>(
      `SELECT s.location_id, l.name AS location_name,
              s.product_id, p.name AS product_name, p.unit AS product_unit,
              s.qty, s.min_level,
              (s.qty - s.min_level) AS shortage
         FROM stock s
         JOIN locations l ON l.id = s.location_id
         JOIN products  p ON p.id = s.product_id
         ${where}
         ORDER BY (s.qty - s.min_level), l.name, p.name
         LIMIT 200`,
      params,
    );
    return rows.map(numerify);
  },
};

// ---------------------------------------------------------------------------
// 5. get_recent_movements
// ---------------------------------------------------------------------------

const getRecentMovements: ToolExecutor = {
  declaration: {
    name: 'get_recent_movements',
    description:
      'Returns the most recent stock movements (sales, transfers, production input/output, ' +
      'purchases, adjustments). Default 20 rows, max 100. Non-PM callers see only movements ' +
      'whose from or to location is theirs.',
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        location_id: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: 'Optional location id (ignored for non-PM callers).',
        },
        product_id: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: 'Optional product id.',
        },
        limit: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: 'Optional row limit, default 20, max 100.',
        },
      },
    },
  },
  async execute(args, principal): Promise<ToolRow[]> {
    const scope = resolveLocationScope(principal, args.location_id);
    if (scope.kind === 'empty') {
      return [];
    }
    const params: SqlParam[] = [];
    const conditions: string[] = [];
    if (scope.kind === 'one') {
      params.push(scope.locationId);
      conditions.push(
        `(m.from_location_id = $${params.length} OR m.to_location_id = $${params.length})`,
      );
    }
    const productId = parseOptionalId(args.product_id);
    if (productId !== null) {
      params.push(productId);
      conditions.push(`m.product_id = $${params.length}`);
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const limit = clampLimit(args.limit, 20, 100);
    params.push(limit);
    const limitIdx = params.length;
    const { rows } = await query<Record<string, unknown>>(
      `SELECT m.id, m.product_id, p.name AS product_name,
              m.from_location_id, fl.name AS from_location_name,
              m.to_location_id,   tl.name AS to_location_name,
              m.qty, m.reason::text AS reason, m.created_at
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN locations fl ON fl.id = m.from_location_id
         LEFT JOIN locations tl ON tl.id = m.to_location_id
         ${where}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $${limitIdx}`,
      params,
    );
    return rows.map(numerify);
  },
};

// ---------------------------------------------------------------------------
// 6. get_sales_summary
// ---------------------------------------------------------------------------

const getSalesSummary: ToolExecutor = {
  declaration: {
    name: 'get_sales_summary',
    description:
      'Aggregated sales over the last `days` days (default 7, max 90), grouped by ' +
      '(location, product, day). Returns (stat_date, location, product, qty_sold, revenue). ' +
      'Sales live only at stores — non-store locations return empty. Non-PM callers see only ' +
      'their own location.',
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        location_id: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: 'Optional store location id (ignored for non-PM callers).',
        },
        product_id: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: 'Optional product id.',
        },
        days: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: 'Window length in days (default 7, max 90).',
        },
      },
    },
  },
  async execute(args, principal): Promise<ToolRow[]> {
    const scope = resolveLocationScope(principal, args.location_id);
    if (scope.kind === 'empty') {
      return [];
    }
    const days = clampLimit(args.days, 7, 90);
    const productId = parseOptionalId(args.product_id);

    const params: SqlParam[] = [days];
    const conditions: string[] = [`s.sold_at >= now() - ($1::int * interval '1 day')`];
    if (scope.kind === 'one') {
      params.push(scope.locationId);
      conditions.push(`s.store_id = $${params.length}`);
    }
    if (productId !== null) {
      params.push(productId);
      conditions.push(`s.product_id = $${params.length}`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const { rows } = await query<Record<string, unknown>>(
      `SELECT date_trunc('day', s.sold_at)::date AS stat_date,
              s.store_id AS location_id, l.name AS location_name,
              s.product_id, p.name AS product_name,
              sum(s.qty)            AS qty_sold,
              sum(s.qty * s.price)  AS revenue
         FROM sales s
         JOIN locations l ON l.id = s.store_id
         JOIN products  p ON p.id = s.product_id
         ${where}
         GROUP BY stat_date, s.store_id, l.name, s.product_id, p.name
         ORDER BY stat_date DESC, location_name, product_name
         LIMIT 200`,
      params,
    );
    return rows.map(numerify);
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOOL_REGISTRY: Record<ToolName, ToolExecutor> = {
  get_stock: getStock,
  get_open_requests: getOpenRequests,
  get_production_plan: getProductionPlan,
  get_below_min: getBelowMin,
  get_recent_movements: getRecentMovements,
  get_sales_summary: getSalesSummary,
};

/** All tool declarations as one Gemini `Tool[]` value. */
export function toolDeclarations(): { functionDeclarations: FunctionDeclaration[] }[] {
  return [
    {
      functionDeclarations: TOOL_NAMES.map((n) => TOOL_REGISTRY[n].declaration),
    },
  ];
}

/** Look up a tool executor by name; throws on unknown name. */
export function getToolExecutor(name: string): ToolExecutor | undefined {
  return (TOOL_NAMES as readonly string[]).includes(name)
    ? TOOL_REGISTRY[name as ToolName]
    : undefined;
}
