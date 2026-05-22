/**
 * `authenticate` middleware — verifies the `Authorization: Bearer <JWT>`
 * header and attaches the principal to `req.auth`.
 *
 * Wired onto every M1-M3 business endpoint; later modules reuse it as-is.
 */
import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../auth/jwt.js';
import { AppError } from '../errors/index.js';
import './types.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Require a valid JWT. On success, `req.auth` is populated and control
 * passes on; on failure, a 401 `UNAUTHENTICATED` error is forwarded.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
    next(AppError.unauthenticated('Missing or malformed Authorization header.'));
    return;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token === '') {
    next(AppError.unauthenticated('Empty bearer token.'));
    return;
  }
  try {
    req.auth = verifyToken(token);
    next();
  } catch {
    // Do not leak verification internals (expired vs. malformed) to clients.
    next(AppError.unauthenticated('Invalid or expired token.'));
  }
}
