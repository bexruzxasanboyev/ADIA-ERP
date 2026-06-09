/**
 * Poster integration routes (spec section 4.9 + ADR-0002):
 *
 *   POST /api/integrations/poster/webhook[/:secret]   — no JWT; secret-token gated
 *   POST /api/integrations/poster/sync                — pm; ?entity=all|locations|products|stock|sales
 *   GET  /api/integrations/poster/status              — pm; recent poster_sync_log rows
 *
 * Webhook auth (TZ OS-6 — until Poster documents an HMAC signature):
 *   Poster lets us configure ANY URL as its webhook target. We embed an
 *   unguessable secret in the URL path (`/webhook/<POSTER_WEBHOOK_SECRET>`)
 *   or in `?secret=<...>`. The handler compares with `timingSafeEqual` and
 *   stores the raw payload — the actual ingestion is async in
 *   `processPendingWebhookEvents` (`posterSalesSync` worker).
 */
import { Router, type Request, type RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { loadConfig } from '../config/index.js';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { createPosterClientFromConfig } from '../integrations/poster/client.js';
import {
  runSeedSync,
  syncCategories,
  syncSpots,
  syncStorages,
  syncIngredients,
  syncPrepacks,
  syncMenuProducts,
  type SeedSelector,
} from '../integrations/poster/seedSync.js';
import { syncStockLeftovers } from '../integrations/poster/stockSync.js';
import { fallbackPollTransactions } from '../integrations/poster/salesSync.js';

export const posterIntegrationRouter: Router = Router();

// -----------------------------------------------------------------------------
// 4.9.1 Webhook endpoint — JWT-less; URL-token gated.
// -----------------------------------------------------------------------------

/**
 * Constant-time secret compare. Returns false when either side is empty so an
 * unconfigured webhook secret never authorises a caller by accident.
 */
function verifyWebhookSecret(received: string | undefined): boolean {
  const expected = loadConfig().poster.webhookSecret;
  if (expected === '' || received === undefined || received === '') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readSecret(req: Request): string | undefined {
  // Accept both `/webhook/<secret>` (path param) and `?secret=<secret>` (query).
  const fromPath = typeof req.params.secret === 'string' ? req.params.secret : undefined;
  const fromQuery = typeof req.query.secret === 'string' ? req.query.secret : undefined;
  return fromPath ?? fromQuery;
}

async function ingestWebhook(req: Request): Promise<void> {
  // Poster sends form-encoded by default, but the docs allow JSON. We accept
  // whatever Express has parsed; otherwise fall back to the raw body if any.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const eventType =
    typeof body.action === 'string' ? body.action :
    typeof body.event_type === 'string' ? body.event_type :
    typeof body.object_type === 'string' ? `${body.object_type}.${body.action ?? 'update'}` :
    'unknown';
  const posterObjectId =
    typeof body.object_id === 'string' || typeof body.object_id === 'number'
      ? Number(body.object_id)
      : typeof body.transaction_id === 'string' || typeof body.transaction_id === 'number'
      ? Number(body.transaction_id)
      : null;
  await query(
    `INSERT INTO poster_webhook_events (event_type, poster_object_id, payload)
     VALUES ($1, $2, $3)`,
    [eventType, Number.isInteger(posterObjectId) ? posterObjectId : null, JSON.stringify(body)],
  );
}

/**
 * C4 (Sprint 3 audit) — per-IP rate limit on the webhook endpoint.
 *
 * The webhook endpoint runs without JWT (Poster cannot send headers), so the
 * only gate is the URL secret. A leaked secret + a high-volume DoS would
 * otherwise flood `poster_webhook_events`. Cap each IP at 60 requests/min;
 * over the limit -> 429 (Poster retries silently). Disabled under `test` so
 * suites that exercise the endpoint in a tight loop are not throttled.
 *
 * Note: deploy may also add an nginx-layer zone limit (ADR-0002 §13). The
 * application-layer cap is the in-process belt-and-braces.
 */
const webhookRateLimit: RequestHandler =
  loadConfig().nodeEnv === 'test'
    ? (_req, _res, next): void => next()
    : rateLimit({
        windowMs: 60 * 1000, // 1 minute
        limit: 60,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res): void => {
          res.status(429).json({
            error: {
              code: 'RATE_LIMITED',
              message: 'Webhook rate limit exceeded — retry later.',
            },
          });
        },
      });

const webhookHandler = asyncHandler(async (req, res) => {
  if (!verifyWebhookSecret(readSecret(req))) {
    // Do NOT leak the reason — log internally, return 401 to Poster.
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'invalid webhook secret' } });
    return;
  }
  await ingestWebhook(req);
  // Quick 200 — actual processing is async (`posterSalesSync` worker).
  res.status(200).json({ received: true });
});

posterIntegrationRouter.post('/webhook', webhookRateLimit, webhookHandler);
posterIntegrationRouter.post('/webhook/:secret', webhookRateLimit, webhookHandler);

// -----------------------------------------------------------------------------
// 4.9.2 Manual full sync — pm only.
// -----------------------------------------------------------------------------

const ENTITY_VALUES: readonly (SeedSelector | 'stock' | 'sales')[] = [
  'all',
  'locations',
  'products',
  'stock',
  'sales',
];

posterIntegrationRouter.post(
  '/sync',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    // Validate the client-supplied request FIRST: a bad `entity` is a client
    // error (422) and must be reported as such regardless of server config.
    // Checking the server-side `POSTER_TOKEN` precondition before this would
    // mask an invalid `entity` behind a 500 whenever the token is unset.
    const entityRaw = typeof req.query.entity === 'string' ? req.query.entity : 'all';
    if (!ENTITY_VALUES.includes(entityRaw as (typeof ENTITY_VALUES)[number])) {
      throw AppError.validation(`Query "entity" must be one of: ${ENTITY_VALUES.join(', ')}.`);
    }
    // Then the server-side precondition: token must be configured so we return
    // a clean error instead of a raw Poster error code 10.
    const cfg = loadConfig();
    if (cfg.poster.token === '') {
      throw AppError.internal('POSTER_TOKEN is not configured — cannot run sync.');
    }
    const client = createPosterClientFromConfig();
    const out: unknown[] = [];
    switch (entityRaw) {
      case 'locations':
        out.push(await syncSpots(client, 'manual'));
        out.push(await syncStorages(client, 'manual'));
        break;
      case 'products':
        // categories first — syncMenuProducts maps menu_category_id -> categories.id.
        out.push(await syncCategories(client, 'manual'));
        out.push(await syncIngredients(client, 'manual'));
        out.push(await syncPrepacks(client, 'manual'));
        out.push(await syncMenuProducts(client, 'manual'));
        break;
      case 'stock': {
        const r = await syncStockLeftovers(client, 'manual');
        out.push({ entity: 'leftovers', ...r });
        break;
      }
      case 'sales': {
        const r = await fallbackPollTransactions(client, 60);
        out.push({ entity: 'transactions', ...r });
        break;
      }
      case 'all':
      default: {
        out.push(...(await runSeedSync(client, 'all')));
        const r = await syncStockLeftovers(client, 'manual');
        out.push({ entity: 'leftovers', ...r });
        break;
      }
    }
    res.status(200).json({ results: out });
  }),
);

// -----------------------------------------------------------------------------
// 4.9.3 Status — pm reads the recent sync log.
// -----------------------------------------------------------------------------

type SyncLogRow = {
  id: number;
  entity: string;
  status: string;
  trigger: string;
  records_in: number;
  records_applied: number;
  error_detail: string | null;
  started_at: Date;
  finished_at: Date | null;
};

posterIntegrationRouter.get(
  '/status',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50) || 50));
    const { rows } = await query<SyncLogRow>(
      `SELECT id, entity, status, trigger, records_in, records_applied,
              error_detail, started_at, finished_at
         FROM poster_sync_log
        ORDER BY started_at DESC
        LIMIT $1`,
      [limit],
    );
    res.status(200).json(rows);
  }),
);
