/**
 * Uzbek display labels for domain enum values.
 * UI text is Uzbek (CLAUDE.md §2); enum keys stay English.
 */
import type {
  LocationType,
  MovementReason,
  ProductType,
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

export const ROLE_OPTIONS: { value: Role; label: string }[] = (
  Object.keys(ROLE_LABELS) as Role[]
).map((value) => ({ value, label: ROLE_LABELS[value] }));

export const LOCATION_TYPE_OPTIONS: { value: LocationType; label: string }[] = (
  Object.keys(LOCATION_TYPE_LABELS) as LocationType[]
).map((value) => ({ value, label: LOCATION_TYPE_LABELS[value] }));

export const PRODUCT_TYPE_OPTIONS: { value: ProductType; label: string }[] = (
  Object.keys(PRODUCT_TYPE_LABELS) as ProductType[]
).map((value) => ({ value, label: PRODUCT_TYPE_LABELS[value] }));

export const UNIT_OPTIONS: { value: Unit; label: string }[] = (
  Object.keys(UNIT_LABELS) as Unit[]
).map((value) => ({ value, label: UNIT_LABELS[value] }));
