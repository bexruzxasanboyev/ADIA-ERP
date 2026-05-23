/**
 * Assistant routes (spec §4 — F2.2 AI assistant).
 *
 *   POST /api/assistant/query             — ask a question (multi-turn, tool calls)
 *   GET  /api/assistant/sessions          — paginated list of caller's sessions
 *   GET  /api/assistant/sessions/:id      — one session + its full message list
 *
 * All endpoints are JWT-authenticated. The assistant is exposed to every role
 * (each principal carries their own RBAC scope, which the tool layer applies).
 *
 * When Vertex is disabled (no GCP creds, or NODE_ENV=test) the query endpoint
 * short-circuits with `503 VERTEX_UNAVAILABLE`. Sessions endpoints still
 * answer (they only read local rows).
 */
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal } from '../lib/principal.js';
import {
  asObject,
  optionalId,
  requireString,
  parseIdParam,
  parseOptionalIdParam,
} from '../lib/validate.js';
import { AppError } from '../errors/index.js';
import { isVertexEnabled } from '../integrations/vertex/client.js';
import {
  getSessionForCaller,
  listSessionsForUser,
  runAssistantQuery,
} from '../services/assistant.js';

export const assistantRouter: Router = Router();

const ALL_ROLES = [
  'pm',
  'raw_warehouse_manager',
  'production_manager',
  'supply_manager',
  'central_warehouse_manager',
  'store_manager',
  'ai_assistant',
] as const;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// POST /api/assistant/query
// ---------------------------------------------------------------------------

assistantRouter.post(
  '/query',
  authenticate,
  authorize(...ALL_ROLES),
  asyncHandler(async (req, res) => {
    if (!isVertexEnabled()) {
      // Spec — keep the error shape, but use a custom code so the frontend
      // can render "AI yordamchi vaqtincha mavjud emas" without confusing it
      // for an auth/validation error.
      res.status(503).json({
        error: {
          code: 'VERTEX_UNAVAILABLE',
          message: 'AI yordamchi vaqtincha mavjud emas.',
        },
      });
      return;
    }

    const body = asObject(req.body);
    const message = requireString(body, 'message');
    const sessionId = optionalId(body, 'session_id');
    const principal = getPrincipal(req);

    try {
      const result = await runAssistantQuery(
        sessionId === undefined
          ? { message, principal }
          : { sessionId, message, principal },
      );
      res.status(200).json(result);
    } catch (err) {
      // The service throws `internal('VERTEX_UNAVAILABLE')` when the client
      // says it's disabled mid-request; map that to the spec 503 shape.
      if (err instanceof AppError && err.message === 'VERTEX_UNAVAILABLE') {
        res.status(503).json({
          error: {
            code: 'VERTEX_UNAVAILABLE',
            message: 'AI yordamchi vaqtincha mavjud emas.',
          },
        });
        return;
      }
      throw err;
    }
  }),
);

// ---------------------------------------------------------------------------
// GET /api/assistant/sessions
// ---------------------------------------------------------------------------

assistantRouter.get(
  '/sessions',
  authenticate,
  authorize(...ALL_ROLES),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const limitRaw = parseOptionalIdParam(
      typeof req.query.limit === 'string' ? req.query.limit : undefined,
      'limit',
    );
    const offsetRaw = req.query.offset;
    const offsetParsed =
      typeof offsetRaw === 'string' && offsetRaw !== '' ? Number(offsetRaw) : 0;
    if (!Number.isInteger(offsetParsed) || offsetParsed < 0) {
      throw AppError.validation('"offset" must be a non-negative integer.');
    }
    const limit = Math.min(limitRaw ?? DEFAULT_LIMIT, MAX_LIMIT);

    const { items, total } = await listSessionsForUser(
      principal.userId,
      limit,
      offsetParsed,
    );
    res.status(200).json({ items, total, limit, offset: offsetParsed });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/assistant/sessions/:id
// ---------------------------------------------------------------------------

assistantRouter.get(
  '/sessions/:id',
  authenticate,
  authorize(...ALL_ROLES),
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id, 'id');
    const principal = getPrincipal(req);
    const detail = await getSessionForCaller(id, principal);
    if (detail === null) {
      throw AppError.notFound('Assistant session not found.');
    }
    res.status(200).json(detail);
  }),
);
