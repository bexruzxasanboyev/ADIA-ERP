/**
 * Pure unit tests for `deriveJourney` — the server-computed mini chain-map
 * ("Variant A + mini-map") every replenishment request carries to the UI.
 * No DB needed: the derivation is a pure function over already-selected columns.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveJourney,
  type JourneyInput,
  type OpenChildInfo,
} from '../src/services/replenishmentJourney.js';

/** A store request baseline — override per case. */
function storeRow(overrides: Partial<JourneyInput> = {}): JourneyInput {
  return {
    status: 'NEW',
    closure_reason: null,
    requester_location_id: 6,
    requester_location_name: 'Kukcha',
    requester_location_type: 'store',
    target_location_id: null,
    target_location_name: null,
    target_location_type: null,
    production_location_id: null,
    production_location_name: null,
    production_order_id: null,
    purchase_order_id: null,
    route_to_production_manual: false,
    ...overrides,
  };
}

describe('deriveJourney — station paths', () => {
  it('store -> central in-stock (NEW, untargeted): [Markaz(logical), Doʻkon], waiting at Markaz', () => {
    const j = deriveJourney(storeRow());
    expect(j.stations.map((s) => s.name)).toEqual(['Markaz', 'Kukcha']);
    expect(j.stations.map((s) => s.type)).toEqual(['central_warehouse', 'store']);
    expect(j.stations[0]?.location_id).toBeNull(); // logical, not yet resolved
    expect(j.current_index).toBe(0);
    expect(j.stations[0]?.state).toBe('current');
    expect(j.stations[1]?.state).toBe('pending');
    expect(j.wait_reason).toBe("Markaz tasdig'i kutilmoqda");
  });

  it('store -> central targeted (CHECK_STORE_SUPPLIER): real central station + named wait reason', () => {
    const j = deriveJourney(
      storeRow({
        status: 'CHECK_STORE_SUPPLIER',
        target_location_id: 3,
        target_location_name: 'Markaziy sklad',
        target_location_type: 'central_warehouse',
      }),
    );
    expect(j.stations.map((s) => s.location_id)).toEqual([3, 6]);
    expect(j.current_index).toBe(0);
    expect(j.wait_reason).toBe("Markaziy sklad tasdig'i kutilmoqda");
  });

  it('store request routed to production (PRODUCING): [Sex, Markaz, Doʻkon], current at the sex, no wait reason', () => {
    const j = deriveJourney(
      storeRow({
        status: 'PRODUCING',
        target_location_id: 3,
        target_location_name: 'Markaziy sklad',
        target_location_type: 'central_warehouse',
        production_location_id: 12,
        production_location_name: 'Tort sexi',
        production_order_id: 41,
      }),
    );
    expect(j.stations.map((s) => s.name)).toEqual(['Tort sexi', 'Markaziy sklad', 'Kukcha']);
    expect(j.stations.map((s) => s.type)).toEqual(['production', 'central_warehouse', 'store']);
    expect(j.current_index).toBe(0);
    expect(j.stations.map((s) => s.state)).toEqual(['current', 'pending', 'pending']);
    expect(j.wait_reason).toBeNull(); // actively producible
  });

  it('DONE_TO_WAREHOUSE: goods sit one hop before the requester (Markaz), production done', () => {
    const j = deriveJourney(
      storeRow({
        status: 'DONE_TO_WAREHOUSE',
        target_location_id: 3,
        target_location_name: 'Markaziy sklad',
        target_location_type: 'central_warehouse',
        production_location_id: 12,
        production_location_name: 'Tort sexi',
        production_order_id: 41,
        route_to_production_manual: true,
      }),
    );
    expect(j.stations.map((s) => s.name)).toEqual(['Tort sexi', 'Markaziy sklad', 'Kukcha']);
    expect(j.current_index).toBe(1);
    expect(j.stations.map((s) => s.state)).toEqual(['done', 'current', 'pending']);
    expect(j.wait_reason).toBeNull(); // actionable (central receives/forwards)
  });

  it("production's raw request with PO wait: [Ombor, Sex skladi] + «Xom-ashyo kutilmoqda (xarid #77)»", () => {
    const j = deriveJourney({
      status: 'CREATE_PURCHASE_ORDER',
      closure_reason: null,
      requester_location_id: 14,
      requester_location_name: 'Tort skladi',
      requester_location_type: 'sex_storage',
      target_location_id: 11,
      target_location_name: 'Ombor',
      target_location_type: 'raw_warehouse',
      production_location_id: null,
      production_location_name: null,
      production_order_id: null,
      purchase_order_id: 77,
      route_to_production_manual: false,
    });
    expect(j.stations.map((s) => s.name)).toEqual(['Ombor', 'Tort skladi']);
    expect(j.stations.map((s) => s.type)).toEqual(['raw_warehouse', 'sex_storage']);
    expect(j.current_index).toBe(0);
    expect(j.wait_reason).toBe('Xom-ashyo kutilmoqda (xarid #77)');
  });

  it('internal request, untargeted, no production leg: falls back to a logical Ombor source', () => {
    const j = deriveJourney(
      storeRow({
        requester_location_id: 14,
        requester_location_name: 'Tort skladi',
        requester_location_type: 'sex_storage',
      }),
    );
    expect(j.stations.map((s) => s.name)).toEqual(['Ombor', 'Tort skladi']);
    expect(j.stations[0]?.location_id).toBeNull();
    expect(j.wait_reason).toBe("Ombor tasdig'i kutilmoqda");
  });

  it('sub-request pinned to a producer sex: [Producer sexi skladi, Soʻragan sex] — no duplicate production station', () => {
    const j = deriveJourney({
      status: 'CHECK_STORE_SUPPLIER',
      closure_reason: null,
      requester_location_id: 14,
      requester_location_name: 'Tort skladi',
      requester_location_type: 'sex_storage',
      target_location_id: 21,
      target_location_name: 'Qaymoq skladi',
      target_location_type: 'sex_storage',
      production_location_id: 21, // equals the target — must NOT add a 3rd station
      production_location_name: 'Qaymoq skladi',
      production_order_id: 9,
      purchase_order_id: null,
      route_to_production_manual: false,
    });
    expect(j.stations.map((s) => s.name)).toEqual(['Qaymoq skladi', 'Tort skladi']);
    expect(j.stations).toHaveLength(2);
    expect(j.current_index).toBe(0);
  });
});

describe('deriveJourney — wait reasons (rule 3)', () => {
  it('a parent waiting on an OPEN child: «{producer}dan {product} kutilmoqda» (overrides the accept-wait phrasing)', () => {
    const openChild: OpenChildInfo = {
      child_request_id: 99,
      product_name: 'Qaymoq krem',
      producer_name: 'Qaymoq sexi',
    };
    const j = deriveJourney(
      storeRow({
        status: 'CHECK_STORE_SUPPLIER',
        target_location_id: 3,
        target_location_name: 'Markaziy sklad',
        target_location_type: 'central_warehouse',
      }),
      openChild,
    );
    expect(j.wait_reason).toBe('Qaymoq sexidan Qaymoq krem kutilmoqda');
  });

  it("an open child with no resolvable producer falls back to «Ta'minotchi»", () => {
    const j = deriveJourney(
      storeRow({ status: 'CHECK_STORE_SUPPLIER' }),
      { child_request_id: 100, product_name: 'Shokolad', producer_name: null },
    );
    expect(j.wait_reason).toBe("Ta'minotchidan Shokolad kutilmoqda");
  });

  it('CREATE_PURCHASE_ORDER without a linked PO id: generic «Xom-ashyo kutilmoqda»', () => {
    const j = deriveJourney(
      storeRow({
        status: 'CREATE_PURCHASE_ORDER',
        target_location_id: 3,
        target_location_name: 'Markaziy sklad',
        target_location_type: 'central_warehouse',
        production_location_id: 12,
        production_location_name: 'Tort sexi',
      }),
    );
    expect(j.wait_reason).toBe('Xom-ashyo kutilmoqda');
    // current sits at the production station (rule 2 — PO wait belongs to the sex).
    expect(j.stations[j.current_index]?.name).toBe('Tort sexi');
  });
});

describe('deriveJourney — transit and terminal', () => {
  it('CLOSED w/o closure_reason (in transit / reserved): current at the requester, previous done, no wait', () => {
    const j = deriveJourney(
      storeRow({
        status: 'CLOSED',
        target_location_id: 3,
        target_location_name: 'Markaziy sklad',
        target_location_type: 'central_warehouse',
      }),
    );
    expect(j.current_index).toBe(1);
    expect(j.stations.map((s) => s.state)).toEqual(['done', 'current']);
    expect(j.wait_reason).toBeNull();
  });

  it('terminal (CLOSED + accepted_full): every station done, no wait reason', () => {
    const j = deriveJourney(
      storeRow({
        status: 'CLOSED',
        closure_reason: 'accepted_full',
        target_location_id: 3,
        target_location_name: 'Markaziy sklad',
        target_location_type: 'central_warehouse',
      }),
    );
    expect(j.stations.every((s) => s.state === 'done')).toBe(true);
    expect(j.current_index).toBe(j.stations.length - 1);
    expect(j.wait_reason).toBeNull();
  });

  it('terminal (CANCELLED): every station done, no wait reason', () => {
    const j = deriveJourney(storeRow({ status: 'CANCELLED', closure_reason: 'rejected' }));
    expect(j.stations.every((s) => s.state === 'done')).toBe(true);
    expect(j.wait_reason).toBeNull();
  });

  it('a CLOSED production-routed request KEEPS its 3-station history (production_order_id link)', () => {
    const j = deriveJourney(
      storeRow({
        status: 'CLOSED',
        closure_reason: 'accepted_full',
        target_location_id: 3,
        target_location_name: 'Markaziy sklad',
        target_location_type: 'central_warehouse',
        production_location_id: 12,
        production_location_name: 'Tort sexi',
        production_order_id: 41,
      }),
    );
    expect(j.stations.map((s) => s.name)).toEqual(['Tort sexi', 'Markaziy sklad', 'Kukcha']);
    expect(j.stations.every((s) => s.state === 'done')).toBe(true);
  });

  it('always yields 2..4 stations (degenerate target==requester gets a logical source)', () => {
    const j = deriveJourney(
      storeRow({ target_location_id: 6, target_location_name: 'Kukcha', target_location_type: 'store' }),
    );
    expect(j.stations.length).toBeGreaterThanOrEqual(2);
    expect(j.stations.length).toBeLessThanOrEqual(4);
  });
});
