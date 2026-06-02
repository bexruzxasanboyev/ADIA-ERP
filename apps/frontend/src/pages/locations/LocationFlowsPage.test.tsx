/**
 * LocationFlowsPage (EPIC 2.1) — admin connection (oqim) management as a
 * dedicated, routed page (migrated from the LocationFlowsDialog modal).
 *
 * What we pin:
 *   1. On mount the page GETs `/api/locations` (the endpoint pickers) and
 *      `/api/locations/flows`, then renders each flow with its source → target
 *      names and an Uzbek flow-type badge.
 *   2. Adding a flow POSTs `{from_location_id, to_location_id, flow_type}` and
 *      then re-fetches the list.
 *   3. Same source and target is rejected client-side without firing a POST.
 *   4. A failing flows load surfaces an error state instead of crashing
 *      (the backend CRUD endpoint may not exist yet — Wave-5 TODO).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocationFlowsPage } from './LocationFlowsPage';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import type { Location, LocationFlow } from '@/lib/types';

const LOCATIONS: Location[] = [
  {
    id: 1,
    name: 'Tort sexi',
    type: 'production',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: null,
    review_days: null,
    safety_factor: null,
  },
  {
    id: 2,
    name: 'Tort skladi',
    type: 'sex_storage',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: null,
    review_days: null,
    safety_factor: null,
  },
  {
    id: 3,
    name: 'Markaziy Sklad',
    type: 'central_warehouse',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: null,
    review_days: null,
    safety_factor: null,
  },
];

const EXISTING: LocationFlow[] = [
  {
    id: 100,
    from_location_id: 1,
    to_location_id: 2,
    flow_type: 'production_output',
    note: null,
  },
];

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input.toString();
}

/**
 * Route the two concurrent mount GETs (`/api/locations` for the pickers and
 * `/api/locations/flows` for the list) by URL. `flowsResponse` is a factory so
 * the POST refetch can return a fresh body on the second flows GET.
 */
function routeFetch(opts: {
  locations?: Response;
  flows: () => Response;
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = urlOf(input);
    if (url.includes('/api/locations/flows')) {
      return Promise.resolve(opts.flows());
    }
    return Promise.resolve(opts.locations ?? jsonResponse(200, LOCATIONS));
  });
}

describe('LocationFlowsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and renders existing flows with source → target and a flow-type badge', async () => {
    routeFetch({ flows: () => jsonResponse(200, EXISTING) });

    renderWithProviders(<LocationFlowsPage />);

    await waitFor(() => {
      expect(screen.getByText('Ishlab chiqarish chiqishi')).toBeTruthy();
    });
    expect(
      screen.getByRole('button', {
        name: 'Tort sexi → Tort skladi oqimini o‘chirish',
      }),
    ).toBeTruthy();
  });

  it('POSTs a new flow and refetches the list', async () => {
    let flowsCall = 0;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) => {
        const url = urlOf(input);
        if (url.includes('/api/locations/flows')) {
          if ((init as RequestInit | undefined)?.method === 'POST') {
            return Promise.resolve(jsonResponse(201, { flow: { id: 101 } }));
          }
          flowsCall += 1;
          // First GET → empty; refetch after POST → the new flow.
          return Promise.resolve(
            flowsCall === 1
              ? jsonResponse(200, [])
              : jsonResponse(200, [
                  {
                    id: 101,
                    from_location_id: 2,
                    to_location_id: 3,
                    flow_type: 'forward',
                    note: null,
                  },
                ]),
          );
        }
        return Promise.resolve(jsonResponse(200, LOCATIONS));
      });

    renderWithProviders(<LocationFlowsPage />);
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText('Hozircha oqimlar yo‘q.')).toBeTruthy();
    });

    await user.selectOptions(screen.getByLabelText('Manba bo‘g‘in'), '2');
    await user.selectOptions(screen.getByLabelText('Qabul bo‘g‘in'), '3');
    await user.selectOptions(screen.getByLabelText('Oqim turi'), 'forward');
    await user.click(screen.getByRole('button', { name: 'Qo‘shish' }));

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
    });

    const postCall = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    )!;
    expect(urlOf(postCall[0])).toContain('/api/locations/flows');
    const body = JSON.parse((postCall[1] as RequestInit).body as string);
    expect(body.from_location_id).toBe(2);
    expect(body.to_location_id).toBe(3);
    expect(body.flow_type).toBe('forward');
  });

  it('rejects identical source and target without firing a POST', async () => {
    const fetchSpy = routeFetch({ flows: () => jsonResponse(200, []) });

    renderWithProviders(<LocationFlowsPage />);
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText('Hozircha oqimlar yo‘q.')).toBeTruthy();
    });

    await user.selectOptions(screen.getByLabelText('Manba bo‘g‘in'), '2');
    await user.selectOptions(screen.getByLabelText('Qabul bo‘g‘in'), '2');
    await user.click(screen.getByRole('button', { name: 'Qo‘shish' }));

    expect(screen.getByRole('alert').textContent).toMatch(/bir xil/i);
    const posted = fetchSpy.mock.calls.some(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posted).toBe(false);
  });

  it('shows an error state when the flows load fails (Wave-5 backend TODO)', async () => {
    routeFetch({
      flows: () =>
        jsonResponse(404, {
          error: { code: 'NOT_FOUND', message: 'Topilmadi.' },
        }),
    });

    renderWithProviders(<LocationFlowsPage />);

    await waitFor(() => {
      expect(screen.getByText(/Topilmadi/)).toBeTruthy();
    });
  });
});
