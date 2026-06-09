/**
 * API router — mounts all Phase-1 module routers under `/api`.
 *
 * Sprint 1 wired M1 (auth, locations, users), M2 (products & recipes) and
 * M3 (stock & movements). Sprint 2 adds M4 (replenishment + state machine),
 * M5 (production orders), and M6 (purchase orders). Sprint 3 adds M7
 * (Poster integration) and M8 (dashboard overview).
 *
 * Each module router applies its own `authenticate` / `authorize` middleware
 * per endpoint — there is no blanket auth on this router, because
 * `POST /api/auth/login` must stay unauthenticated.
 */
import { Router } from 'express';
import express from 'express';
import { authRouter } from './auth.js';
import { locationsRouter } from './locations.js';
import { usersRouter } from './users.js';
import { productsRouter } from './products.js';
import { stockRouter } from './stock.js';
import { replenishmentRouter } from './replenishment.js';
import { productionOrdersRouter } from './productionOrders.js';
import { productionDialogRouter } from './productionDialog.js';
import { productionPlanRouter } from './productionPlan.js';
import { purchaseOrdersRouter } from './purchaseOrders.js';
import { posterIntegrationRouter } from './posterIntegration.js';
import { dashboardRouter } from './dashboard.js';
import { dashboardDetailRouter } from './dashboardDetail.js';
import { adminRouter } from './admin.js';
import { assistantRouter } from './assistant.js';
import { telegramWebhookRouter } from './telegramWebhook.js';
import { forecastsRouter } from './forecasts.js';
import { salesRouter } from './sales.js';
import { nakladnoyRouter } from './nakladnoy.js';
import { cashShiftsRouter } from './cashShifts.js';
import { safeExpensesRouter } from './safeExpenses.js';
import { kpiRouter } from './kpi.js';
import { storeKpiRouter } from './storeKpi.js';
import { sellerKpiRouter } from './sellerKpi.js';
import { discrepanciesRouter } from './discrepancies.js';
import { inventoryRouter } from './inventory.js';

export const apiRouter: Router = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/locations', locationsRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/products', productsRouter);
apiRouter.use('/stock', stockRouter);
apiRouter.use('/replenishment', replenishmentRouter);
apiRouter.use('/production-orders', productionOrdersRouter);
// EPIC 5 / ADR-0016 — channel-agnostic AI production dialog (web channel).
apiRouter.use('/production/dialog', productionDialogRouter);
// cross-dept-flow §6.4 / F-B — the N-component "Manba reja" (source plan):
// analyze (read) + execute (one transaction). The dialog Q1/Q2 generalised.
apiRouter.use('/production-plan', productionPlanRouter);
apiRouter.use('/purchase-orders', purchaseOrdersRouter);
apiRouter.use('/dashboard', dashboardRouter);
// Dashboard MEGA Redesign Sprint C — per-stage detail drawers
// (GET /api/dashboard/{raw|production|supply|central|stores}).
apiRouter.use('/dashboard', dashboardDetailRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.use('/assistant', assistantRouter);
// F3.4 / ADR-0010 — Prophet forecasts (read-only; PM scoped or per-location).
apiRouter.use('/forecasts', forecastsRouter);
// F4.6 — read-only sales window for the Stores layer page.
apiRouter.use('/sales', salesRouter);
// EPIC 8.4 — material requisition (nakladnoy) generated from a BOM demand.
apiRouter.use('/nakladnoy', nakladnoyRouter);
// EPIC 8.5 — kassa smenasi (cash shift) close-out, read-only from Poster.
apiRouter.use('/cash-shifts', cashShiftsRouter);
// EPIC 8.7 — seyf rasxodlari (safe expenses), read-only from Poster finance.
apiRouter.use('/safe-expenses', safeExpensesRouter);
// KPI production-costing (2026-06-06) — the per-product full cost / profit
// report. pm only. (The old /overhead pool API was removed once utilities
// became a per-product manual value — see migration 0051.)
apiRouter.use('/kpi', kpiRouter);
// TZ M8 — Do'kon KPI (store-level): monthly sales plan, plan-vs-actual
// achievement %, month-over-month growth, and the store leaderboard.
// GET is pm/ai_assistant chain-wide + store_manager own-store; PUT /plan is
// pm only (a planning input). Actual revenue reconciles with the Stores
// dashboard's sum(qty*price) over `sales`.
apiRouter.use('/store-kpi', storeKpiRouter);
// TZ M8 — Do'kon KPI (SELLER-level): per-cashier/waiter monthly sales total,
// target/plan, achievement %, MoM growth, ranking. ACTUAL revenue read LIVE
// from Poster dash.getWaitersSales (Variant B — `sales` has no seller dim).
// GET is pm/ai_assistant chain-wide + store_manager own-store; PUT /plan and
// POST /sync are pm only. Poster stays read-only; degrades to empty on a
// method-level Poster failure.
apiRouter.use('/seller-kpi', sellerKpiRouter);
// TZ M9 — kassa tafovuti / fors-major discrepancy log + report. pm/ai_assistant
// chain-wide; location managers scoped to their own location(s).
apiRouter.use('/discrepancies', discrepanciesRouter);
// TZ M11 — inventarizatsiya (bo'lak ↔ butun converter + kun-oxiri count). The
// end-of-day worksheet decomposes system qty into whole/pieces; POST /count
// reconciles stock with one atomic 'adjust' movement. pm/ai_assistant read
// chain-wide; managers scoped to their own location(s).
apiRouter.use('/inventory', inventoryRouter);
// EPIC 4.3 (2026-05-29) — the "Yetkazib berish" / delivery module was removed.
// Departments now ship directly and the receiver accepts on arrival; there is
// no separate courier-assignment surface. The replenishment state machine
// (/api/replenishment) carries the request straight through. The old
// `assigned_to_user_id` column (migration 0015) is left in place (no
// destructive SQL); it is simply no longer exposed over HTTP.
// F3.3 / ADR-0011 — Telegram webhook (public, secret-token authed).
// Mounted before the Poster sub-router so the JSON body parser at the
// app level handles Telegram's `application/json` payloads.
apiRouter.use('/telegram', telegramWebhookRouter);
// Poster sends webhook payloads as form-encoded by default; parse them on
// this sub-tree only (JWT routes elsewhere remain JSON-only).
apiRouter.use(
  '/integrations/poster',
  express.urlencoded({ extended: true, limit: '1mb' }),
  posterIntegrationRouter,
);
