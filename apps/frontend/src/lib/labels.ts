/**
 * Uzbek display labels for domain enum values.
 * UI text is Uzbek (CLAUDE.md §2); enum keys stay English.
 */
import type { DateRangePreset } from '@/components/DateRangeFilter';
import type {
  CashReconciliationStatus,
  DashboardAlertType,
  DiscrepancyKind,
  DiscrepancyStatus,
  FlowType,
  LocationType,
  MovementReason,
  PipelineStage,
  PosterSyncStatus,
  ProductType,
  ProductionOrderStatus,
  PurchaseOrderStatus,
  RecipeStage,
  ReplenishmentStatus,
  Role,
  Unit,
} from './types';

export const ROLE_LABELS: Record<Role, string> = {
  pm: 'Loyiha rahbari',
  raw_warehouse_manager: 'Xom-ashyo ombori boshlig‘i',
  production_manager: 'Ishlab chiqarish boshlig‘i',
  // Renamed from "Ta'minot boshlig'i" — the layer is now "Ishlab chiqarish ombori"
  // (Tort / Perojniy / Yarim Fabrika sex storages). The Role enum key
  // stays `supply_manager` for back-compat with the backend.
  supply_manager: 'Ishlab chiqarish ombori boshlig‘i',
  central_warehouse_manager: 'Markaziy sklad boshlig‘i',
  store_manager: 'Do‘kon boshlig‘i',
  // `ai_assistant` mirrors the backend enum but is not user-facing in
  // Faza-1 — it is intentionally excluded from ROLE_OPTIONS below so it
  // never appears in role pickers.
  ai_assistant: 'AI assistent',
};

/**
 * EPIC 3 (Hodimlar redesign) — per-role accent tokens for the grouped
 * employee cards/sections, mirroring the products page colour-coding.
 * `accent` is the Tailwind left-border colour used as the card's left rail;
 * all are light-mode-safe (a 500-weight border reads on both themes).
 * `ring` tints the section heading dot. Every Role key is covered so the
 * map is total (no `??` fallback needed at the call site).
 */
export const ROLE_ACCENT_STYLE: Record<Role, { accent: string; dot: string }> = {
  // Roles wear the colour of their chain link (chain-* tokens); PM oversees
  // the whole chain so it takes the brand cobalt, AI the info teal.
  pm: { accent: 'border-l-primary', dot: 'bg-primary' },
  raw_warehouse_manager: { accent: 'border-l-chain-raw', dot: 'bg-chain-raw' },
  production_manager: {
    accent: 'border-l-chain-production',
    dot: 'bg-chain-production',
  },
  supply_manager: { accent: 'border-l-chain-supply', dot: 'bg-chain-supply' },
  central_warehouse_manager: {
    accent: 'border-l-chain-central',
    dot: 'bg-chain-central',
  },
  store_manager: { accent: 'border-l-chain-store', dot: 'bg-chain-store' },
  ai_assistant: { accent: 'border-l-info', dot: 'bg-info' },
};

export const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  raw_warehouse: 'Xom-ashyo ombori',
  production: 'Ishlab chiqarish',
  // Legacy "Ta'minot bo'limi" — kept as a back-compat label until the
  // backend ENUM migration finishes; once the API only emits
  // `sex_storage` this entry can be dropped.
  supply: 'Ishlab chiqarish ombori',
  sex_storage: 'Ishlab chiqarish ombori',
  central_warehouse: 'Markaziy sklad',
  store: 'Do‘kon',
};

// EPIC 2.1 — oqim (connection) turlari. Admin bo'g'inlar orasidagi oqimni
// shu turlardan biri bilan belgilaydi (location_flows.flow_type).
export const FLOW_TYPE_LABELS: Record<FlowType, string> = {
  production_output: 'Ishlab chiqarish chiqishi',
  bom_input: 'Yarim tayyor qaytishi',
  forward: 'Oldinga oqim',
  reverse: 'Qaytar oqim',
};

export const FLOW_TYPE_OPTIONS: { value: FlowType; label: string }[] = (
  Object.keys(FLOW_TYPE_LABELS) as FlowType[]
).map((value) => ({ value, label: FLOW_TYPE_LABELS[value] }));

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  raw: 'Xom-ashyo',
  semi: 'Yarim tayyor',
  finished: 'Tayyor mahsulot',
};

export const UNIT_LABELS: Record<Unit, string> = {
  kg: 'kg',
  l: 'l',
  pcs: 'dona',
};

/**
 * EPIC 1.5 — BOM stage section labels for the recipe modal. `other` is the
 * catch-all used when the backend has not (yet) tagged a line with a stage.
 */
export const RECIPE_STAGE_LABELS: Record<RecipeStage, string> = {
  dough: 'Hamir',
  cream: 'Krem',
  decoration: 'Bezak',
  other: 'Boshqa',
};

/** Stable display order of BOM stages in the recipe modal. */
export const RECIPE_STAGE_ORDER: RecipeStage[] = [
  'dough',
  'cream',
  'decoration',
  'other',
];

/**
 * EPIC 8.4 — nakladnoy section headings ("krem uchun", "hamir uchun"…).
 * The owner wants each BOM stage to read as "<stage> uchun" so the
 * nakladnoy is self-describing (image19).
 */
export const NAKLADNOY_SECTION_LABELS: Record<RecipeStage, string> = {
  dough: 'Hamir uchun',
  cream: 'Krem uchun',
  decoration: 'Bezak uchun',
  other: 'Boshqa',
};

/** EPIC 8.5 — kassa smenasi holati. */
export const CASH_SHIFT_STATUS_LABELS: Record<
  import('./types').CashShiftStatus,
  string
> = {
  open: 'Ochiq',
  closed: 'Yopilgan',
};

/** TZ Module 15 — kassa solishtiruvi holati (Uzbek labels). */
export const CASH_RECONCILIATION_STATUS_LABELS: Record<
  CashReconciliationStatus,
  string
> = {
  matched: 'Mos',
  discrepancy: 'Tafovut',
  no_poster_data: 'Poster ma’lumoti yo‘q',
};

/** Badge variant per reconciliation status (matched=green, discrepancy=red). */
export const CASH_RECONCILIATION_STATUS_VARIANT: Record<
  CashReconciliationStatus,
  'success' | 'danger' | 'secondary'
> = {
  matched: 'success',
  discrepancy: 'danger',
  no_poster_data: 'secondary',
};

/** Status filter options (leading "Barchasi" with an empty value). */
export const CASH_RECONCILIATION_STATUS_OPTIONS: {
  value: string;
  label: string;
}[] = [
  { value: '', label: 'Barchasi' },
  ...(Object.keys(CASH_RECONCILIATION_STATUS_LABELS) as CashReconciliationStatus[]).map(
    (value) => ({ value, label: CASH_RECONCILIATION_STATUS_LABELS[value] }),
  ),
];

// ---------------------------------------------------------------------------
// Dashboard date-range copy (EPIC 0.4).
//
// The revenue / receipts KPI titles must follow the selected period filter
// instead of staying frozen on "Bugungi tushum". These maps are the single
// source of truth shared by HeroStrip and RevenueBreakdown so the headline
// wording never drifts between the two widgets.
// ---------------------------------------------------------------------------

/** Revenue card title per period, e.g. `today → "Bugungi tushum"`. */
export const REVENUE_TITLE_BY_RANGE: Record<DateRangePreset, string> = {
  today: 'Bugungi tushum',
  week: 'Bu haftalik tushum',
  month: 'Bu oylik tushum',
  '6m': '6 oylik tushum',
  custom: 'Davr tushumi',
};

/** Receipts card title per period, e.g. `today → "Bugungi sotuvlar"`. */
export const RECEIPTS_TITLE_BY_RANGE: Record<DateRangePreset, string> = {
  today: 'Bugungi sotuvlar',
  week: 'Bu haftalik sotuvlar',
  month: 'Bu oylik sotuvlar',
  '6m': '6 oylik sotuvlar',
  custom: 'Davr sotuvlari',
};

/** Delta-pill comparison caption per period, e.g. `today → "kechaga"`. */
export const COMPARISON_LABEL_BY_RANGE: Record<DateRangePreset, string> = {
  today: 'kechaga',
  week: "o'tgan haftaga",
  month: "o'tgan oyga",
  '6m': 'oldingi 6 oyga',
  custom: 'oldingi davrga',
};

/** Revenue title for an optional range; falls back to "Bugungi tushum". */
export function revenueTitleForRange(range?: DateRangePreset): string {
  return REVENUE_TITLE_BY_RANGE[range ?? 'today'];
}

export const MOVEMENT_REASON_LABELS: Record<MovementReason, string> = {
  sale: 'Savdo',
  production_input: 'Ishlab chiqarishga sarf',
  production_output: 'Ishlab chiqarishdan kirim',
  transfer: 'Ko‘chirish',
  purchase: 'Sotib olish',
  adjust: 'Qo‘lda tuzatuv',
};

/**
 * Source / destination ("Manba / Manzil") column labels for a stock movement
 * whose counterparty location is NULL. A `transfer` always carries a real
 * counterparty location name (rendered directly), so it maps to a generic
 * fallback here only for completeness. Every other reason has no counterparty
 * location — instead of an unhelpful "—" the table shows where the stock came
 * from / went (owner feedback: the Manba/Manzil column must always be
 * meaningful).
 */
export const MOVEMENT_COUNTERPARTY_LABELS: Record<MovementReason, string> = {
  production_output: 'Ishlab chiqarish',
  production_input: 'Ishlab chiqarish',
  purchase: 'Ta’minotchi (xarid)',
  sale: 'Sotuv (POS)',
  adjust: 'Tuzatish / Brak',
  transfer: 'Ko‘chirish',
};

/**
 * Resolve the "Manba / Manzil" cell for a movement: prefer the real
 * counterparty location name when present, else a reason-based label so the
 * cell is never an opaque "—".
 */
export function movementCounterpartyLabel(
  counterpartyName: string | null,
  reason: MovementReason,
): string {
  return counterpartyName ?? MOVEMENT_COUNTERPARTY_LABELS[reason];
}

/**
 * "Amal" (chain-level flow direction) of a stock movement, classified by which
 * endpoint is open:
 *   - `kirish`     — `from_location_id == null`: stock ENTERED the chain
 *     (production output, purchase, positive adjust) — green.
 *   - `chiqish`    — `to_location_id == null`: stock LEFT the chain (sale,
 *     consumption, negative adjust) — red.
 *   - `kochirish`  — both endpoints set: a transfer BETWEEN two locations —
 *     neutral, rendered with an arrow.
 *
 * Null-safe: the id fields are optional on the wire (the backend is adding them
 * in parallel). When BOTH ids are absent/undefined we fall back to the
 * `from_location_name` / `to_location_name` fields (a `null`/absent name reads
 * as "no endpoint"), so the column degrades gracefully on older rows. When both
 * endpoints read as null (shouldn't happen) we treat it as `kochirish` so the
 * chip never disappears.
 */
export type MovementFlowKind = 'kirish' | 'chiqish' | 'kochirish';

export const MOVEMENT_FLOW_LABELS: Record<MovementFlowKind, string> = {
  kirish: 'Kirish',
  chiqish: 'Chiqish',
  kochirish: 'Ko‘chirish',
};

export function movementFlowKind(m: {
  from_location_id?: number | null;
  to_location_id?: number | null;
  from_location_name?: string | null;
  to_location_name?: string | null;
}): MovementFlowKind {
  // Prefer the explicit ids; fall back to the presence of a counterparty name
  // when the backend has not (yet) sent the ids on this row.
  const hasFrom =
    m.from_location_id != null ||
    (m.from_location_id === undefined && m.from_location_name != null);
  const hasTo =
    m.to_location_id != null ||
    (m.to_location_id === undefined && m.to_location_name != null);
  if (hasFrom && hasTo) return 'kochirish';
  if (!hasFrom && hasTo) return 'kirish';
  if (hasFrom && !hasTo) return 'chiqish';
  return 'kochirish';
}

/**
 * Role picker options for forms. Excludes `ai_assistant` because the AI
 * assistant role is not provisioned by an admin in Faza-1 — its tokens
 * are minted server-side. Order matches the RBAC matrix in §6.
 */
export const ROLE_OPTIONS: { value: Role; label: string }[] = (
  Object.keys(ROLE_LABELS) as Role[]
)
  .filter((role) => role !== 'ai_assistant')
  .map((value) => ({ value, label: ROLE_LABELS[value] }));

// `supply` is the legacy synonym of `sex_storage` and would otherwise
// produce a duplicate "Ishlab chiqarish ombori" entry in pickers — exclude it from
// the visible option list. The label entry stays so any row arriving
// from the backend with the legacy enum still renders correctly.
export const LOCATION_TYPE_OPTIONS: { value: LocationType; label: string }[] = (
  Object.keys(LOCATION_TYPE_LABELS) as LocationType[]
)
  .filter((value) => value !== 'supply')
  .map((value) => ({ value, label: LOCATION_TYPE_LABELS[value] }));

export const PRODUCT_TYPE_OPTIONS: { value: ProductType; label: string }[] = (
  Object.keys(PRODUCT_TYPE_LABELS) as ProductType[]
).map((value) => ({ value, label: PRODUCT_TYPE_LABELS[value] }));

export const UNIT_OPTIONS: { value: Unit; label: string }[] = (
  Object.keys(UNIT_LABELS) as Unit[]
).map((value) => ({ value, label: UNIT_LABELS[value] }));

// ---------------------------------------------------------------------------
// Sprint 2 — replenishment / production order / purchase order labels.
// ---------------------------------------------------------------------------

/** Uzbek labels for the 10-status replenishment state machine. */
export const REPLENISHMENT_STATUS_LABELS: Record<ReplenishmentStatus, string> = {
  NEW: 'Yangi',
  CHECK_STORE_SUPPLIER: 'Tekshiruv: sex skladi/markaziy sklad',
  SHIP_TO_REQUESTER: 'So‘rovchiga jo‘natish',
  CHECK_PRODUCTION_INPUT: 'Tekshiruv: ishlab chiqarish xom-ashyosi',
  CREATE_PURCHASE_ORDER: 'Sotib olish so‘rovi',
  CREATE_PRODUCTION_ORDER: 'Ishlab chiqarish zayafkasi',
  PRODUCING: 'Ishlab chiqarilmoqda',
  DONE_TO_WAREHOUSE: 'Markaziy skladga topshirildi',
  CLOSED: 'Yopilgan',
  CANCELLED: 'Bekor qilingan',
};

/** Replenishment status badge variant — visual hierarchy on lists. */
export const REPLENISHMENT_STATUS_VARIANT: Record<
  ReplenishmentStatus,
  'default' | 'outline' | 'success' | 'warning' | 'danger'
> = {
  NEW: 'warning',
  CHECK_STORE_SUPPLIER: 'default',
  SHIP_TO_REQUESTER: 'default',
  CHECK_PRODUCTION_INPUT: 'default',
  CREATE_PURCHASE_ORDER: 'default',
  CREATE_PRODUCTION_ORDER: 'default',
  PRODUCING: 'default',
  DONE_TO_WAREHOUSE: 'default',
  CLOSED: 'success',
  CANCELLED: 'danger',
};

export const REPLENISHMENT_STATUS_OPTIONS: {
  value: ReplenishmentStatus;
  label: string;
}[] = (Object.keys(REPLENISHMENT_STATUS_LABELS) as ReplenishmentStatus[]).map(
  (value) => ({ value, label: REPLENISHMENT_STATUS_LABELS[value] }),
);

/**
 * Central-warehouse pipeline stage labels (owner's corrected single-flow
 * logic). These are the five So'rovlar tab titles in the markaziy sklad
 * workspace; `yopilgan` (closed/cancelled history) is not a tab on its own —
 * closed lines surface in Tranzaksiyalar — but the label is kept total so the
 * map covers every `PipelineStage`.
 */
export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  kutuvda: 'Kutuvda',
  soralgan: 'So‘ralgan',
  qabul_qilingan: 'Qabul qilingan',
  yuborilgan: 'Yuborilgan',
  yopilgan: 'Yopilgan',
};

/** Uzbek labels for production order statuses. */
export const PRODUCTION_ORDER_STATUS_LABELS: Record<ProductionOrderStatus, string> = {
  new: 'Yangi',
  in_progress: 'Jarayonda',
  done: 'Yakunlangan',
  cancelled: 'Bekor qilingan',
};

export const PRODUCTION_ORDER_STATUS_VARIANT: Record<
  ProductionOrderStatus,
  'default' | 'outline' | 'success' | 'warning' | 'danger'
> = {
  new: 'warning',
  in_progress: 'default',
  done: 'success',
  cancelled: 'danger',
};

export const PRODUCTION_ORDER_STATUS_OPTIONS: {
  value: ProductionOrderStatus;
  label: string;
}[] = (
  Object.keys(PRODUCTION_ORDER_STATUS_LABELS) as ProductionOrderStatus[]
).map((value) => ({ value, label: PRODUCTION_ORDER_STATUS_LABELS[value] }));

/** Uzbek labels for purchase order statuses. */
export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: 'Loyiha',
  approved: 'Tasdiqlangan',
  received: 'Qabul qilingan',
  cancelled: 'Bekor qilingan',
  rejected: 'Rad etilgan',
};

export const PURCHASE_ORDER_STATUS_VARIANT: Record<
  PurchaseOrderStatus,
  'default' | 'outline' | 'success' | 'warning' | 'danger'
> = {
  draft: 'warning',
  approved: 'default',
  received: 'success',
  cancelled: 'danger',
  rejected: 'danger',
};

export const PURCHASE_ORDER_STATUS_OPTIONS: {
  value: PurchaseOrderStatus;
  label: string;
}[] = (
  Object.keys(PURCHASE_ORDER_STATUS_LABELS) as PurchaseOrderStatus[]
).map((value) => ({ value, label: PURCHASE_ORDER_STATUS_LABELS[value] }));

// ---------------------------------------------------------------------------
// Faza-3 F3.2 — AI write-action labels (PendingActionCard).
// Keys match the backend tool registry; unknown keys fall back to the raw
// tool name in the UI (consciously visible, not branded).
// ---------------------------------------------------------------------------

/**
 * Uzbek labels for AI write tools. Each label is short enough to fit on
 * a single line of the PendingActionCard header — emoji is part of the
 * label so the badge reads visually at a glance.
 */
export const ASSISTANT_WRITE_TOOL_LABELS: Record<string, string> = {
  transfer_stock: '🔄 Tovar ko‘chirish',
  create_replenishment_request: '📋 Yangi so‘rov',
  mark_production_order_done: '✅ Zayafkani yakunlash',
  approve_purchase_order: '👍 Sotib olishni tasdiqlash',
  update_minmax: '✏️ Min/Max o‘zgartirish',
  create_production_order: '🏭 Yangi zayafka',
};

/** Lookup helper — falls back to the raw tool name when unmapped. */
export function assistantWriteToolLabel(toolName: string): string {
  return ASSISTANT_WRITE_TOOL_LABELS[toolName] ?? toolName;
}

// ---------------------------------------------------------------------------
// Faza-4 F4.4 — Dashboard ecosystem labels (Poster sync, alerts feed).
// ---------------------------------------------------------------------------

/** Uzbek labels for Poster sync statuses. */
export const POSTER_SYNC_STATUS_LABELS: Record<PosterSyncStatus, string> = {
  ok: 'Muvaffaqiyatli',
  partial: 'Qisman',
  failed: 'Xatolik',
};

/** Badge variant per Poster sync status. */
export const POSTER_SYNC_STATUS_VARIANT: Record<
  PosterSyncStatus,
  'success' | 'warning' | 'danger'
> = {
  ok: 'success',
  partial: 'warning',
  failed: 'danger',
};

/** Uzbek labels for dashboard alert (notification) types. */
export const DASHBOARD_ALERT_TYPE_LABELS: Record<DashboardAlertType, string> = {
  stock_below_min: 'Min’dan tushdi',
  replenishment_created: 'Yangi to‘ldirish so‘rovi',
  production_order_created: 'Yangi zayafka',
  production_order_done: 'Zayafka yakunlandi',
  shipment_created: 'Jo‘natma',
  purchase_request_created: 'Sotib olish so‘rovi',
  purchase_request_approved: 'Sotib olish tasdiqlandi',
  poster_sync_failed: 'Poster sync xato',
  negative_stock_detected: 'Manfiy qoldiq',
};

/** Lookup helper — falls back to the raw type string when unmapped. */
export function dashboardAlertTypeLabel(type: string): string {
  return (
    DASHBOARD_ALERT_TYPE_LABELS[type as DashboardAlertType] ?? type
  );
}

// ---------------------------------------------------------------------------
// TZ Module 9 — Kassa tafovuti / fors-major ogohlantirishlar.
// ---------------------------------------------------------------------------

/** Uzbek labels for discrepancy kinds. */
export const DISCREPANCY_KIND_LABELS: Record<DiscrepancyKind, string> = {
  wrong_keyed: 'Ortiqcha sotuv',
  negative_stock: 'Manfiy ostatka',
};

/** Badge variant per discrepancy kind. */
export const DISCREPANCY_KIND_VARIANT: Record<
  DiscrepancyKind,
  'warning' | 'danger'
> = {
  wrong_keyed: 'warning',
  negative_stock: 'danger',
};

/** Kind filter options (leading "Barchasi" with an empty value). */
export const DISCREPANCY_KIND_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Barchasi' },
  ...(Object.keys(DISCREPANCY_KIND_LABELS) as DiscrepancyKind[]).map(
    (value) => ({ value, label: DISCREPANCY_KIND_LABELS[value] }),
  ),
];

/** Uzbek labels for discrepancy statuses. */
export const DISCREPANCY_STATUS_LABELS: Record<DiscrepancyStatus, string> = {
  open: 'Ochiq',
  acknowledged: 'Tasdiqlangan',
  resolved: 'Hal qilingan',
};

/** Badge variant per discrepancy status (visual hierarchy on the list). */
export const DISCREPANCY_STATUS_VARIANT: Record<
  DiscrepancyStatus,
  'default' | 'outline' | 'success' | 'warning'
> = {
  open: 'warning',
  acknowledged: 'default',
  resolved: 'success',
};

/** Status filter options (leading "Barchasi" with an empty value). */
export const DISCREPANCY_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Barchasi' },
  ...(Object.keys(DISCREPANCY_STATUS_LABELS) as DiscrepancyStatus[]).map(
    (value) => ({ value, label: DISCREPANCY_STATUS_LABELS[value] }),
  ),
];

// ---------------------------------------------------------------------------
// TZ Module 11 — Inventarizatsiya konverteri (bo'lak ↔ butun).
// Shared Uzbek copy for the page header + the whole/piece/remnant columns so
// the wording stays identical between the count table and the count history.
// ---------------------------------------------------------------------------

export const INVENTORY_LABELS = {
  title: 'Inventarizatsiya',
  description:
    'Tortlar kg bo‘yicha sotiladi. Tizimdagi qoldiq «butun + bo‘lak + qoldiq» ko‘rinishida ko‘rsatiladi; kun oxirida fizik sanoq kiritib, qoldiqni solishtiring.',
  whole: 'Butun',
  piece: 'Bo‘lak',
  remnant: 'Qoldiq (kg)',
  system: 'Tizimda',
  counted: 'Hisoblangan',
  /** Hint shown for a product whose coefficients are not yet configured. */
  coefficientNeeded: 'Koeffitsiyent kerak',
  coefficientButton: 'Koeffitsiyent',
} as const;

/**
 * Compose the "{whole} butun + {pieces} bo'lak" caption (with an optional
 * "+ {remnant} kg qoldiq" tail). The single source for both the system
 * decomposition cell and the history rows so the phrasing never drifts.
 */
export function formatWholePiece(
  whole: number,
  pieces: number,
  remnantKg = 0,
): string {
  const base = `${whole} ${INVENTORY_LABELS.whole.toLowerCase()} + ${pieces} ${INVENTORY_LABELS.piece.toLowerCase()}`;
  return remnantKg > 0 ? `${base} + ${remnantKg} kg qoldiq` : base;
}

// ---------------------------------------------------------------------------
// TZ Module 8 — Sotuvchi KPI (seller-level monthly sales plan vs actual).
// Shared Uzbek copy for the page header + table columns + summary cards so the
// wording stays identical between the Do'kon KPI and Sotuvchi KPI pages.
// ---------------------------------------------------------------------------

export const SELLER_KPI_LABELS = {
  title: 'Sotuvchi KPI',
  description:
    'Har bir sotuvchining oylik sotuv rejasi va haqiqiy sotuviga nisbatan bajarilishi. Reyting va o‘sish dinamikasi.',
  /** Top summary cards. */
  totalTarget: 'Jami reja (so‘m)',
  totalActual: 'Jami haqiqiy (so‘m)',
  totalAchievement: 'Umumiy bajarilish',
  /** Table column headers. */
  colRank: 'Reyting',
  colSeller: 'Sotuvchi',
  colStore: 'Do‘kon',
  colPlan: 'Plan',
  colActual: 'Haqiqiy',
  colAchievement: 'Bajarilish %',
  colGrowth: 'O‘sish',
  colAction: 'Amal',
  /** Controls + actions. */
  monthLabel: 'Oyni tanlash',
  storeFilterLabel: 'Do‘kon bo‘yicha filtr',
  allStores: 'Barcha do‘konlar',
  setPlan: 'Plan belgilash',
  /** States. */
  empty: 'Ma’lumot yo‘q',
} as const;
