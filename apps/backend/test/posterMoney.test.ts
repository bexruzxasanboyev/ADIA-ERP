/**
 * EPIC 0.3 — Poster money-unit helper.
 *
 * Live diagnostic (2026-05-29, account `adia`) proved the two revenue
 * endpoints use DIFFERENT units:
 *   - dash.getAnalytics   -> already in so'm   ("19553300.0000" for one day)
 *   - dash.getPaymentsReport `payed_*_sum` -> TIYIN, exactly 100× larger
 *     (same day: payed_sum_sum = 1955330000 == 19553300 * 100).
 * So `getPaymentsReport` totals must be divided by 100 before they reconcile
 * with the headline revenue. These tests pin that contract.
 */
import { describe, expect, it } from 'vitest';
import {
  tiyinToSom,
  paymentReportToBuckets,
  transactionsToBuckets,
  analyticsToDailySom,
} from '../src/integrations/poster/posterMoney.js';
import type { PosterTransactionSummary } from '../src/integrations/poster/client.js';

describe('tiyinToSom', () => {
  it('divides tiyin by 100 to get so\'m', () => {
    expect(tiyinToSom('1955330000')).toBe(19_553_300);
    expect(tiyinToSom(6_666_172_000)).toBe(66_661_720);
  });

  it('returns 0 for empty / non-numeric input', () => {
    expect(tiyinToSom(undefined)).toBe(0);
    expect(tiyinToSom('')).toBe(0);
    expect(tiyinToSom('abc')).toBe(0);
    expect(tiyinToSom(null as unknown as string)).toBe(0);
  });
});

describe('paymentReportToBuckets', () => {
  it('maps the real {total} aggregate to so\'m buckets that reconcile', () => {
    // Verified-against-live payload (2026-05-29 day total).
    const report = {
      days: [],
      total: {
        payed_cash_sum: 870_577_000,
        payed_card_sum: 1_084_753_000,
        payed_ewallet_sum: 0,
        payed_cert_in_sum: 0,
        payed_cert_out_sum: 0,
        payed_bonus_sum: 0,
        payed_sum_sum: 1_955_330_000,
        transactions_count: 84,
      },
    };
    const { byMethod, total } = paymentReportToBuckets(report);
    // tiyin -> so'm
    expect(byMethod.cash).toBe(8_705_770);
    expect(byMethod.card).toBe(10_847_530);
    expect(total).toBe(19_553_300);
    // Buckets reconcile to the reported total.
    const sum =
      byMethod.cash + byMethod.card + byMethod.payme + byMethod.click + byMethod.other;
    expect(sum).toBe(total);
  });

  it('routes ewallet/third-party into a dedicated bucket so total still reconciles', () => {
    const report = {
      total: {
        payed_cash_sum: 100_000, // 1000 so'm
        payed_card_sum: 0,
        payed_ewallet_sum: 50_000, // 500 so'm -> "other" (Payme/Click not split by this endpoint)
        payed_sum_sum: 150_000,
      },
    };
    const { byMethod, total } = paymentReportToBuckets(report);
    expect(byMethod.cash).toBe(1000);
    expect(byMethod.other).toBe(500);
    expect(total).toBe(1500);
    const sum =
      byMethod.cash + byMethod.card + byMethod.payme + byMethod.click + byMethod.other;
    expect(sum).toBe(total);
  });

  it('falls back to summing components when payed_sum_sum is absent', () => {
    const report = {
      total: {
        payed_cash_sum: 200_000,
        payed_card_sum: 300_000,
      },
    };
    const { total } = paymentReportToBuckets(report);
    expect(total).toBe(5000); // (200000 + 300000) / 100
  });

  it('handles a row-array legacy shape by classifying titles', () => {
    const legacy = [
      { payment_id: 1, payment_title: 'Наличные', payment_sum: '100000' },
      { payment_id: 2, payment_title: 'Карта', payment_sum: '200000' },
      { payment_id: 5, payment_title: 'Payme', payment_sum: '50000' },
    ];
    const { byMethod, total } = paymentReportToBuckets(legacy);
    expect(byMethod.cash).toBe(1000);
    expect(byMethod.card).toBe(2000);
    expect(byMethod.payme).toBe(500);
    expect(total).toBe(3500);
  });
});

describe('transactionsToBuckets', () => {
  // The `adia` payment-method map (verified live 2026-06-06). Payme=19,
  // Click=20; ids are account-specific, classified by TITLE not number.
  const adiaMethods = [
    { payment_method_id: '1', title: 'Наличные' },
    { payment_method_id: '2', title: 'Карта' },
    { payment_method_id: '14', title: 'Доверительный платеж' },
    { payment_method_id: '17', title: 'Карта|Абдулқодир ака' },
    { payment_method_id: '19', title: 'Payme' },
    { payment_method_id: '20', title: 'Click' },
  ];

  /** Build a closed transaction (tiyin strings, as Poster emits). */
  function txn(
    over: Partial<PosterTransactionSummary>,
  ): PosterTransactionSummary {
    return {
      transaction_id: '1',
      spot_id: '1',
      pay_type: '1',
      payment_method_id: '0',
      payed_cash: '0',
      payed_card: '0',
      payed_third_party: '0',
      payed_ewallet: '0',
      payed_bonus: '0',
      payed_sum: '0',
      ...over,
    };
  }

  it('gives every named custom method its own row (incl. card-titled) and reconciles', () => {
    const transactions: PosterTransactionSummary[] = [
      // pm_id 0, cash (default split)
      txn({ pay_type: '1', payment_method_id: '0', payed_cash: '500000', payed_sum: '500000' }),
      // pm_id 0, card (default split)
      txn({ pay_type: '2', payment_method_id: '0', payed_card: '300000', payed_sum: '300000' }),
      // pm_id 19 Payme — whole txn -> payme (Poster folds this into card otherwise)
      txn({ pay_type: '2', payment_method_id: '19', payed_card: '122350000', payed_sum: '122350000' }),
      // pm_id 20 Click — whole txn -> click
      txn({ pay_type: '2', payment_method_id: '20', payed_card: '91350000', payed_sum: '91350000' }),
      // pm_id 14 "Доверительный платеж" -> its OWN named row pm_14
      txn({ pay_type: '2', payment_method_id: '14', payed_card: '198383600', payed_sum: '198383600' }),
      // pm_id 17 "Карта|Абдулқодир ака" -> its OWN named row pm_17 (NOT folded into card)
      txn({ pay_type: '2', payment_method_id: '17', payed_card: '31640000', payed_sum: '31640000' }),
      // open/unpaid -> ignored
      txn({ pay_type: '0', payment_method_id: '0', payed_sum: '999999999' }),
    ];

    const expected =
      5000 + 3000 + 1_223_500 + 913_500 + 1_983_836 + 316_400; // so'm
    const out = transactionsToBuckets(transactions, adiaMethods, expected);

    expect(out.byMethod.cash).toBe(5000);
    // card = ONLY the default-split card (3000) — id 17 no longer folds in here.
    expect(out.byMethod.card).toBe(3000);
    expect(out.byMethod.payme).toBe(1_223_500);
    expect(out.byMethod.click).toBe(913_500);
    expect(out.byMethod.other).toBe(0);
    expect(out.closedCount).toBe(6);

    // The two named custom methods reconcile against the live-verified figures.
    const pm14 = out.methods.find((m) => m.key === 'pm_14');
    const pm17 = out.methods.find((m) => m.key === 'pm_17');
    expect(pm14).toEqual({ key: 'pm_14', label: 'Доверительный платеж', amount: 1_983_836 });
    expect(pm17).toEqual({ key: 'pm_17', label: 'Карта|Абдулқодир ака', amount: 316_400 });

    // The 4 core methods always lead the list, in fixed order.
    expect(out.methods.slice(0, 4)).toEqual([
      { key: 'cash', label: 'Naqd', amount: 5000 },
      { key: 'card', label: 'Karta', amount: 3000 },
      { key: 'payme', label: 'Payme', amount: 1_223_500 },
      { key: 'click', label: 'Click', amount: 913_500 },
    ]);
    // Named customs follow, sorted by amount desc (pm_14 > pm_17). No `other`
    // row (residual is 0).
    expect(out.methods.map((m) => m.key)).toEqual([
      'cash',
      'card',
      'payme',
      'click',
      'pm_14',
      'pm_17',
    ]);

    // sum(methods) === total === expected (exact reconciliation).
    const methodsSum = out.methods.reduce((s, m) => s + m.amount, 0);
    expect(methodsSum).toBe(out.total);
    expect(out.total).toBe(expected);
    expect(out.reconcileWarning).toBeNull();
  });

  it('always lists the 4 core methods even at zero, and appends a residual other row', () => {
    const transactions: PosterTransactionSummary[] = [
      // default-split with cash + a third-party residual -> unnamed `other`.
      txn({
        pay_type: '3',
        payment_method_id: '0',
        payed_cash: '100000',
        payed_third_party: '50000',
        payed_sum: '150000',
      }),
    ];
    const out = transactionsToBuckets(transactions, adiaMethods);

    // Core 4 present even though card/payme/click are 0.
    expect(out.methods.slice(0, 4)).toEqual([
      { key: 'cash', label: 'Naqd', amount: 1000 },
      { key: 'card', label: 'Karta', amount: 0 },
      { key: 'payme', label: 'Payme', amount: 0 },
      { key: 'click', label: 'Click', amount: 0 },
    ]);
    // Unnamed residual gets the trailing `other` row.
    expect(out.methods[out.methods.length - 1]).toEqual({
      key: 'other',
      label: 'Boshqa',
      amount: 500,
    });
    const methodsSum = out.methods.reduce((s, m) => s + m.amount, 0);
    expect(methodsSum).toBe(out.total);
    expect(out.total).toBe(1500);
  });

  it('flags a reconcile warning when buckets drift from the expected total', () => {
    const transactions: PosterTransactionSummary[] = [
      txn({ pay_type: '1', payment_method_id: '0', payed_cash: '100000', payed_sum: '100000' }),
    ];
    // Buckets = 1000 so'm; tell it we expected 9999 -> drift > 1 so'm.
    const out = transactionsToBuckets(transactions, adiaMethods, 9999);
    expect(out.total).toBe(1000);
    expect(out.reconcileWarning).not.toBeNull();
  });

  it('folds third_party/ewallet/bonus into other for default-split txns', () => {
    const transactions: PosterTransactionSummary[] = [
      txn({
        pay_type: '3',
        payment_method_id: '0',
        payed_cash: '100000',
        payed_card: '200000',
        payed_third_party: '50000',
        payed_ewallet: '30000',
        payed_bonus: '20000',
        payed_sum: '400000',
      }),
    ];
    const out = transactionsToBuckets(transactions, adiaMethods);
    expect(out.byMethod.cash).toBe(1000);
    expect(out.byMethod.card).toBe(2000);
    expect(out.byMethod.other).toBe(1000); // 500 + 300 + 200
    expect(out.total).toBe(4000);
  });

  it('returns an all-zero breakdown for no transactions', () => {
    const out = transactionsToBuckets([], adiaMethods);
    expect(out.total).toBe(0);
    expect(out.closedCount).toBe(0);
    expect(out.byMethod).toEqual({ cash: 0, card: 0, payme: 0, click: 0, other: 0 });
    // The 4 core methods still list (so the manager sees they exist); no
    // `other` row when the residual is 0.
    expect(out.methods).toEqual([
      { key: 'cash', label: 'Naqd', amount: 0 },
      { key: 'card', label: 'Karta', amount: 0 },
      { key: 'payme', label: 'Payme', amount: 0 },
      { key: 'click', label: 'Click', amount: 0 },
    ]);
  });
});

describe('analyticsToDailySom', () => {
  it('aligns the data series day-by-day from dateFrom (so\'m, no ÷100)', () => {
    // Tail of the real 2026-05-29 diagnostic series (already so'm).
    const analytics = {
      data: ['31059707.0000', '34788091.0000', '49282950.0000'],
      counters: { revenue: '115130748.0000' },
    };
    const out = analyticsToDailySom(analytics, '2026-04-30');
    expect(out).toEqual([
      { date: '2026-04-30', revenue: 31_059_707 },
      { date: '2026-05-01', revenue: 34_788_091 },
      { date: '2026-05-02', revenue: 49_282_950 },
    ]);
  });

  it('returns [] for an empty or missing series', () => {
    expect(analyticsToDailySom({ data: [] }, '2026-05-01')).toEqual([]);
    expect(analyticsToDailySom(undefined, '2026-05-01')).toEqual([]);
    expect(analyticsToDailySom({ data: ['1'] }, 'bad-date')).toEqual([]);
  });
});
