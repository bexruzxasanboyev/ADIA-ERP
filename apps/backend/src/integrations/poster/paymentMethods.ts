/**
 * Sub-task #7 — Poster payment-method mapping.
 *
 * Poster's `dash.getPaymentsReport` returns one row per payment method per
 * day (`payment_id`, `payment_title`, `payment_count`, `payment_sum`). The
 * built-in Poster methods are stable across accounts:
 *
 *   payment_id = 1 -> cash    (Naqd)
 *   payment_id = 2 -> card    (Karta)
 *
 * Uzbek "online" payment methods (Payme, Click) are custom payment methods
 * the operator configures inside Poster — their `payment_id` is account-
 * specific (Poster assigns the next free integer). We therefore match by
 * the `payment_title` STRING when the numeric id is unknown, so the
 * mapping stays correct after a Poster admin renames or re-creates a
 * method. Anything we can't classify lands in the `other` bucket so the
 * total still reconciles.
 *
 * The mapping is intentionally permissive — Poster localises titles in
 * Russian/Uzbek so we match case-insensitively against substring patterns.
 * Add new pattern lists here (and only here) when the operator wires up
 * another e-wallet.
 */

export type PaymentMethodKey = 'cash' | 'card' | 'payme' | 'click' | 'other';

/** Numeric Poster payment_id -> our canonical method key. */
const ID_MAP: Readonly<Record<number, PaymentMethodKey>> = {
  1: 'cash',
  2: 'card',
};

/**
 * Title -> key pattern lists. Match is case-insensitive substring; first
 * match wins. Keep specific patterns (Payme/Click) BEFORE generic ones
 * (card / cash) so a method titled "Payme Karta" still resolves to payme.
 */
const TITLE_PATTERNS: ReadonlyArray<{ key: PaymentMethodKey; needles: string[] }> = [
  { key: 'payme', needles: ['payme', 'пайме'] },
  { key: 'click', needles: ['click', 'клик'] },
  { key: 'card', needles: ['card', 'карта', 'karta', 'visa', 'humo', 'uzcard'] },
  { key: 'cash', needles: ['cash', 'нал', 'naqd', 'наличн'] },
];

/**
 * Resolve a Poster payment method to our canonical key.
 *
 * @param paymentId    Numeric `payment_id` from Poster (parsed to number).
 *                     Pass `undefined` when only the title is known.
 * @param paymentTitle Free-text title from Poster (`payment_title` or the
 *                     transaction's `payed_*` field name). Optional.
 * @returns A canonical key. Unknown methods become 'other' so the total
 *          reconciles against the sum-of-all-buckets in the dashboard.
 */
export function classifyPosterPayment(
  paymentId: number | undefined,
  paymentTitle: string | undefined,
): PaymentMethodKey {
  if (paymentId !== undefined && Number.isFinite(paymentId)) {
    const hit = ID_MAP[paymentId];
    if (hit !== undefined) return hit;
  }
  if (typeof paymentTitle === 'string' && paymentTitle.trim() !== '') {
    const haystack = paymentTitle.toLowerCase();
    for (const { key, needles } of TITLE_PATTERNS) {
      if (needles.some((n) => haystack.includes(n))) return key;
    }
  }
  return 'other';
}

/** Empty bucket map — caller seeds this then accumulates each Poster row. */
export function emptyPaymentBuckets(): Record<PaymentMethodKey, number> {
  return { cash: 0, card: 0, payme: 0, click: 0, other: 0 };
}

/** One row of `settings.getPaymentMethods` as far as the resolver cares. */
export type PaymentMethodLike = {
  payment_method_id: string | number;
  title?: string;
};

/**
 * Build a `payment_method_id -> canonical key` resolver from the account's
 * `settings.getPaymentMethods` list. Each method is classified by its TITLE
 * (case-insensitive substring) via `classifyPosterPayment`, so the mapping
 * stays correct even though the numeric ids are account-specific (Payme/Click
 * ids differ per Poster account — for `adia` they are 19/20, verified live
 * 2026-06-06, but we never hardcode that here).
 *
 * The returned function also handles the per-transaction sentinel
 * `payment_method_id = 0` (or unknown id): it returns `null`, signalling the
 * caller to fall back to the transaction's own cash/card split.
 */
export function buildMethodKeyResolver(
  methods: ReadonlyArray<PaymentMethodLike>,
): (paymentMethodId: number | undefined) => PaymentMethodKey | null {
  const byId = new Map<number, PaymentMethodKey>();
  for (const m of methods) {
    const id = Number(m.payment_method_id);
    if (!Number.isInteger(id) || id <= 0) continue;
    // Resolve via title first (stable across accounts); the numeric id only
    // helps for the built-in 1=cash / 2=card defaults inside classify*.
    byId.set(id, classifyPosterPayment(id, m.title));
  }
  return (paymentMethodId: number | undefined): PaymentMethodKey | null => {
    if (paymentMethodId === undefined || !Number.isFinite(paymentMethodId)) {
      return null;
    }
    if (paymentMethodId === 0) return null; // no custom method -> caller splits
    return byId.get(paymentMethodId) ?? null;
  };
}

/**
 * A resolved custom payment method. `core` keys (cash/card/payme/click) fold
 * into the canonical buckets; a `named` resolution gets its OWN bucket keyed
 * `pm_<id>` with the Poster title shown verbatim — money reconciliation must be
 * exact, so we never collapse a real, named method into a generic bucket by
 * title.
 */
export type ResolvedMethod =
  | { kind: 'core'; key: PaymentMethodKey }
  | { kind: 'named'; key: string; label: string };

/**
 * Built-in Poster method id 1=cash / 2=card always fold into the core buckets,
 * regardless of title. Payme/Click custom methods are detected by title and
 * fold into the core `payme`/`click` keys (the dashboard keeps them as first-
 * class columns). EVERY OTHER custom method (id >= 3) becomes its own NAMED
 * bucket — including card-titled ones like "Карта|Абдулқодир ака", which used
 * to disappear into `card`.
 */
const NAMED_CORE_PATTERNS: ReadonlyArray<{
  key: Extract<PaymentMethodKey, 'payme' | 'click'>;
  needles: string[];
}> = [
  { key: 'payme', needles: ['payme', 'пайме'] },
  { key: 'click', needles: ['click', 'клик'] },
];

/** Stable bucket key for a named custom method. */
export function namedMethodKey(id: number): string {
  return `pm_${id}`;
}

/**
 * Build a per-transaction `payment_method_id -> ResolvedMethod` resolver.
 *
 * Unlike `buildMethodKeyResolver`, custom methods that are neither Payme nor
 * Click resolve to a NAMED bucket carrying the verbatim Poster title, so the
 * revenue breakdown lists every method by its real name. Returns `null` for
 * the `payment_method_id = 0` sentinel and for unknown ids (caller then splits
 * the transaction's own cash/card fields).
 */
export function buildMethodResolver(
  methods: ReadonlyArray<PaymentMethodLike>,
): (paymentMethodId: number | undefined) => ResolvedMethod | null {
  const byId = new Map<number, ResolvedMethod>();
  for (const m of methods) {
    const id = Number(m.payment_method_id);
    if (!Number.isInteger(id) || id <= 0) continue;
    byId.set(id, resolveCustomMethod(id, m.title));
  }
  return (paymentMethodId: number | undefined): ResolvedMethod | null => {
    if (paymentMethodId === undefined || !Number.isFinite(paymentMethodId)) {
      return null;
    }
    if (paymentMethodId === 0) return null; // no custom method -> caller splits
    return byId.get(paymentMethodId) ?? null;
  };
}

function resolveCustomMethod(
  id: number,
  title: string | undefined,
): ResolvedMethod {
  // Built-in ids fold into core buckets regardless of title.
  const builtin = ID_MAP[id];
  if (builtin !== undefined) return { kind: 'core', key: builtin };

  const haystack = typeof title === 'string' ? title.toLowerCase() : '';
  for (const { key, needles } of NAMED_CORE_PATTERNS) {
    if (needles.some((n) => haystack.includes(n))) return { kind: 'core', key };
  }
  // Every other custom method keeps its own name. Fall back to the key itself
  // when Poster omits a title (defensive — titles are always present live).
  const label =
    typeof title === 'string' && title.trim() !== ''
      ? title
      : namedMethodKey(id);
  return { kind: 'named', key: namedMethodKey(id), label };
}
