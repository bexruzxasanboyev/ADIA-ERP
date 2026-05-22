/**
 * API router — mounts all Phase-1 module routers under `/api`.
 *
 * Sprint 1 wires M1 (auth, locations, users), M2 (products & recipes) and
 * M3 (stock & movements). Later sprints add M4-M9 here.
 *
 * Each module router applies its own `authenticate` / `authorize` middleware
 * per endpoint — there is no blanket auth on this router, because
 * `POST /api/auth/login` must stay unauthenticated.
 */
import { Router } from 'express';
import { authRouter } from './auth.js';
import { locationsRouter } from './locations.js';
import { usersRouter } from './users.js';
import { productsRouter } from './products.js';
import { stockRouter } from './stock.js';

export const apiRouter: Router = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/locations', locationsRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/products', productsRouter);
apiRouter.use('/stock', stockRouter);
