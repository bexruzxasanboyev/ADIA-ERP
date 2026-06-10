// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isRenderableJourney, type Journey } from './replenishmentFlow';

/** A well-formed 3-station journey (store order being made at the sex). */
const journey: Journey = {
  stations: [
    { location_id: 5, name: 'Tort sexi', type: 'production', state: 'current' },
    {
      location_id: 2,
      name: 'Markaziy sklad',
      type: 'central_warehouse',
      state: 'pending',
    },
    { location_id: 9, name: 'Kukcha', type: 'store', state: 'pending' },
  ],
  current_index: 0,
  wait_reason: null,
};

describe('isRenderableJourney — wire guard for the ChainStrip', () => {
  it('accepts a well-formed 2..4-station journey', () => {
    expect(isRenderableJourney(journey)).toBe(true);
    expect(
      isRenderableJourney({ ...journey, stations: journey.stations.slice(0, 2) }),
    ).toBe(true);
  });

  it('rejects absent / null (backend not landed yet) without crashing', () => {
    expect(isRenderableJourney(undefined)).toBe(false);
    expect(isRenderableJourney(null)).toBe(false);
  });

  it('rejects malformed payloads (empty / single station / bad shapes)', () => {
    expect(isRenderableJourney({ ...journey, stations: [] })).toBe(false);
    expect(
      isRenderableJourney({ ...journey, stations: journey.stations.slice(0, 1) }),
    ).toBe(false);
    expect(
      isRenderableJourney({
        ...journey,
        // A station missing its name must not blow up the strip.
        stations: [
          ...journey.stations.slice(0, 1),
          { bad: true } as unknown as Journey['stations'][number],
        ],
      }),
    ).toBe(false);
    expect(
      isRenderableJourney({
        stations: 'oops',
        current_index: 0,
        wait_reason: null,
      } as unknown as Journey),
    ).toBe(false);
  });
});
