/**
 * Uzbek display labels for domain enum values.
 * UI text is Uzbek (CLAUDE.md §2); enum keys stay English.
 */
import type {
  LocationType,
  MovementReason,
  ProductType,
  ProductionOrderStatus,
  PurchaseOrderStatus,
  ReplenishmentStatus,
  Role,
  Unit,
} from './types';

export const ROLE_LABELS: Record<Role, string> = {
  pm: 'Loyiha rahbari',
  raw_warehouse_manager: 'Xom-ashyo ombori boshlig‘i',
  production_manager: 'Ishlab chiqarish boshlig‘i',
  supply_manager: 'Ta’minot boshlig‘i',
  central_warehouse_manager: 'Markaziy sklad boshlig‘i',
  store_manager: 'Do‘kon boshlig‘i',
  // `ai_assistant` mirrors the backend enum but is not user-facing in
  // Faza-1 — it is intentionally excluded from ROLE_OPTIONS below so it
  // never appears in role pickers.
  ai_assistant: 'AI assistent',
};

export const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  raw_warehouse: 'Xom-ashyo ombori',
  production: 'Ishlab chiqarish',
  supply: 'Ta’minot bo‘limi',
  central_warehouse: 'Markaziy sklad',
  store: 'Do‘kon',
};

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

export const MOVEMENT_REASON_LABELS: Record<MovementReason, string> = {
  sale: 'Savdo',
  production_input: 'Ishlab chiqarishga sarf',
  production_output: 'Ishlab chiqarishdan kirim',
  transfer: 'Ko‘chirish',
  purchase: 'Sotib olish',
  adjust: 'Tuzatish',
};

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

export const LOCATION_TYPE_OPTIONS: { value: LocationType; label: string }[] = (
  Object.keys(LOCATION_TYPE_LABELS) as LocationType[]
).map((value) => ({ value, label: LOCATION_TYPE_LABELS[value] }));

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
  CHECK_STORE_SUPPLIER: 'Tekshiruv: ta’minot/markaziy sklad',
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
