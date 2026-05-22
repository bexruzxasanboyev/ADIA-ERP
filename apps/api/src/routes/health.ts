/**
 * Health endpoint — `GET /health`.
 *
 * Reports process liveness and database connectivity. Unauthenticated by
 * design (used by load balancers / uptime checks). Returns 200 when the DB
 * ping succeeds, 503 when it fails.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { ping } from '../db/index.js';

export const healthRouter: Router = Router();

healthRouter.get('/health', async (_req: Request, res: Response) => {
  let dbOk = false;
  try {
    dbOk = await ping();
  } catch (err) {
    console.error('[health] db ping failed:', (err as Error).message);
    dbOk = false;
  }

  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    service: 'adia-erp-api',
    db: dbOk ? 'up' : 'down',
    time: new Date().toISOString(),
  });
});
