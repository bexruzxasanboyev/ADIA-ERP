/**
 * Express application assembly.
 *
 * `createApp()` builds the app WITHOUT binding a port — this keeps it
 * importable by tests (supertest drives it in-process). `server.ts` is the
 * thin entrypoint that listens.
 *
 * Sprint 1 wires the health route plus the M1-M3 API router under `/api`.
 * Later sprints add M4-M9 inside `apiRouter`.
 *
 * Production hardening:
 *  - `helmet()` sets the standard security headers (HSTS, X-Content-Type-
 *    Options, X-Frame-Options, etc.). CSP is intentionally disabled — this
 *    is a JSON API, no HTML is rendered.
 *  - `cors()` is locked to the configured `WEB_ORIGIN` (single-origin ERP,
 *    not a public API). Credentials are not used (JWT goes in the
 *    Authorization header, not in cookies), so `credentials: false`.
 */
import express from 'express';
import type { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { loadConfig } from './config/index.js';
import { healthRouter } from './routes/health.js';
import { apiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp(): Express {
  const app = express();
  const cfg = loadConfig();

  // --- Global middleware ----------------------------------------------------
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: cfg.webOrigin, credentials: false }));
  app.use(express.json({ limit: '1mb' }));

  // --- Routes ---------------------------------------------------------------
  app.use(healthRouter);
  app.use('/api', apiRouter); // M1-M3 now; M4-M9 added in later sprints.

  // --- Error handling (must be last) ---------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
