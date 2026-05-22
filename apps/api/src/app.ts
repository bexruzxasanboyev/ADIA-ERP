/**
 * Express application assembly.
 *
 * `createApp()` builds the app WITHOUT binding a port — this keeps it
 * importable by tests (supertest drives it in-process). `server.ts` is the
 * thin entrypoint that listens.
 *
 * Sprint 1 wires the health route plus the M1-M3 API router under `/api`.
 * Later sprints add M4-M9 inside `apiRouter`.
 */
import express from 'express';
import type { Express } from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health.js';
import { apiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp(): Express {
  const app = express();

  // --- Global middleware ----------------------------------------------------
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // --- Routes ---------------------------------------------------------------
  app.use(healthRouter);
  app.use('/api', apiRouter); // M1-M3 now; M4-M9 added in later sprints.

  // --- Error handling (must be last) ---------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
