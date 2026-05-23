/**
 * Worker-level test for `runOneCycle()` — the function the cron job invokes.
 *
 * Two branches must be covered:
 *   1. happy path — `runEngineCycle()` resolves; if any work was done a
 *      single line is logged (visibility for the ops dashboard);
 *   2. error path — `runEngineCycle()` rejects; the error is SWALLOWED and
 *      logged so the cron stays alive for the next 5-minute tick.
 *
 * Both branches mock `runEngineCycle` via `vi.mock` so the test stays purely
 * a unit test and does not depend on the test database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEngineCycle } from '../src/services/replenishment.js';
import { runOneCycle } from '../src/workers/replenishmentScan.js';

vi.mock('../src/services/replenishment.js', () => ({
  // Mocked spy — every test sets its own behaviour via mockResolvedValueOnce
  // or mockRejectedValueOnce, keeping the suite self-contained.
  runEngineCycle: vi.fn(),
}));

const mockedRunEngineCycle = vi.mocked(runEngineCycle);

describe('runOneCycle (replenishment-scan worker)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockedRunEngineCycle.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('logs a summary line when the cycle did at least one thing', async () => {
    mockedRunEngineCycle.mockResolvedValueOnce({ scanned: 3, created: 1, advanced: 2 });

    await runOneCycle();

    expect(mockedRunEngineCycle).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('[replenishment-scan]');
    expect(line).toContain('scanned=3');
    expect(line).toContain('created=1');
    expect(line).toContain('advanced=2');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('stays silent when the cycle did nothing (no noisy logs)', async () => {
    mockedRunEngineCycle.mockResolvedValueOnce({ scanned: 0, created: 0, advanced: 0 });

    await runOneCycle();

    expect(mockedRunEngineCycle).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('swallows and logs an error so the cron keeps ticking', async () => {
    mockedRunEngineCycle.mockRejectedValueOnce(new Error('boom'));

    // The promise MUST resolve — if it rejected, node-cron would surface an
    // unhandled rejection and the next 5-minute tick could be skipped.
    await expect(runOneCycle()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('[replenishment-scan] cycle failed');
    const reason = String(errorSpy.mock.calls[0]?.[1] ?? '');
    expect(reason).toContain('boom');
  });
});
