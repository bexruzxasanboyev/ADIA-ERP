/**
 * Express application assembly.
 *
 * `createApp()` builds the app WITHOUT binding a port — this keeps it
 * importable by tests (supertest drives it in-process). `server.ts` is the
 * thin entrypoint that listens.
 *
 * Sprint 0 wires only the health route and the cross-cutting middleware.
 * Business routers (M1-M9) plug into the same place in the next sprint.
 */
import express from 'express';
import type { Express } from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp(): Express {
  const app = express();

  // --- Global middleware ----------------------------------------------------
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // --- Routes ---------------------------------------------------------------
  app.use(healthRouter);
  // Future: app.use('/api', apiRouter);  // M1-M9, JWT-protected

  // --- Error handling (must be last) ---------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
