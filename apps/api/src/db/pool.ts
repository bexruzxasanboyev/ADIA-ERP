/**
 * PostgreSQL connection pool — the single shared `pg.Pool` for the process.
 *
 * Raw SQL only (no ORM, TZ section 10). The pool is created lazily on first
 * use so that importing this module never opens a connection (important for
 * tests and tooling).
 */
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { loadConfig } from '../config/index.js';

let pool: Pool | undefined;

/** Get the process-wide connection pool, creating it on first call. */
export function getPool(): Pool {
  if (pool === undefined) {
    const cfg = loadConfig();
    const poolConfig: PoolConfig = {
      connectionString: cfg.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Phase 1 is a single self-hosted VPS — no SSL on the local connection.
      application_name: 'adia-erp-api',
    };
    pool = new Pool(poolConfig);
    pool.on('error', (err) => {
      // An idle client errored — log; the pool removes it automatically.
      console.error('[db] idle client error:', err.message);
    });
  }
  return pool;
}

/** Close the pool — call on graceful shutdown and after test suites. */
export async function closePool(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
  }
}
