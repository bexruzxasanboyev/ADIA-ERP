/**
 * B2 (telegram-bot-tz §3) — onboarding menu + reply-keyboard router.
 *
 * Covers the role-based keyboard shape, the greeting, and the message:text
 * router (menu buttons handled; non-menu text falls through so cash-shift is
 * not broken).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import {
  buildMenuKeyboard,
  buildGreeting,
  handleMenuMessage,
  isMenuButton,
  MENU,
  type MenuCtxLike,
} from '../src/integrations/telegram/menuHandler.js';

let ctx: TestContext;
let storeId: number;
let centralId: number;
let storeManager: number;
let tgId: number;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  centralId = await makeLocation(ctx.db, { type: 'central_warehouse' });
  storeId = await makeLocation(ctx.db, {
    type: 'store',
    name: 'Kukcha',
    parentId: centralId,
  });
  const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: storeId });
  storeManager = sm.id;
  tgId = 700000 + storeManager;
  await ctx.db.query(`UPDATE users SET telegram_id = $1 WHERE id = $2`, [
    String(tgId),
    storeManager,
  ]);
});

function fakeCtx(text: string, id = tgId): MenuCtxLike & {
  replies: Array<{ text: string; opts?: Record<string, unknown> }>;
} {
  const replies: Array<{ text: string; opts?: Record<string, unknown> }> = [];
  return {
    from: { id },
    message: { text },
    replies,
    async reply(t: string, opts?: Record<string, unknown>) {
      replies.push({ text: t, opts });
      return undefined;
    },
  };
}

describe('buildMenuKeyboard (B2)', () => {
  it('store_manager gets the full action set', () => {
    const kb = buildMenuKeyboard('store_manager');
    const flat = kb.keyboard.flat();
    expect(flat).toContain(MENU.voice);
    expect(flat).toContain(MENU.sendRequest);
    expect(flat).toContain(MENU.incoming);
    expect(flat).toContain(MENU.products);
  });

  it('central_warehouse_manager gets incoming + up, no sendRequest', () => {
    const kb = buildMenuKeyboard('central_warehouse_manager');
    const flat = kb.keyboard.flat();
    expect(flat).toContain(MENU.incoming);
    expect(flat).toContain(MENU.up);
    expect(flat).not.toContain(MENU.sendRequest);
  });

  it('pm is read-only — status + reports buttons, no operational actions', () => {
    const kb = buildMenuKeyboard('pm');
    const flat = kb.keyboard.flat();
    expect(flat).toEqual([MENU.status, MENU.reports]);
    expect(flat).not.toContain(MENU.incoming);
  });

  it('every role with a menu exposes the Hisobotlar button', () => {
    for (const role of [
      'store_manager',
      'central_warehouse_manager',
      'production_manager',
      'supply_manager',
      'raw_warehouse_manager',
      'pm',
    ] as const) {
      expect(buildMenuKeyboard(role).keyboard.flat()).toContain(MENU.reports);
    }
  });
});

describe('buildGreeting (B2)', () => {
  it('names the user, their location, and role', () => {
    const text = buildGreeting({
      userName: 'Aziz',
      role: 'store_manager',
      locationName: 'Kukcha',
    });
    expect(text).toContain('Aziz');
    expect(text).toContain('Kukcha');
    expect(text).toContain("bo'limidasiz");
  });
});

describe('handleMenuMessage router (B2)', () => {
  it('falls through (handled=false) for non-menu text — cash-shift untouched', async () => {
    const res = await handleMenuMessage(fakeCtx('rasxod 5 000 000, qoldim 3 000 000'));
    expect(res.handled).toBe(false);
  });

  it('isMenuButton recognises a menu label', () => {
    expect(isMenuButton(MENU.incoming)).toBe(true);
    expect(isMenuButton('random chat')).toBe(false);
  });

  it('"📦 Mahsulotlar" lists the store stock summary', async () => {
    const p = await makeProduct(ctx.db, { name: 'НАПОЛЕОН', unit: 'pcs' });
    await setStock(ctx.db, { locationId: storeId, productId: p, qty: 12, minLevel: 5, maxLevel: 50 });
    const c = fakeCtx(MENU.products);
    const res = await handleMenuMessage(c);
    expect(res.handled).toBe(true);
    expect(res.action).toBe('products');
    expect(c.replies[0]?.text).toContain('НАПОЛЕОН');
    expect(c.replies[0]?.text).toContain('12');
  });

  it('"📥 Kelgan so\'rovlar" shows empty when none', async () => {
    // The store manager's own location has no incoming requests targeting it.
    const c = fakeCtx(MENU.incoming);
    const res = await handleMenuMessage(c);
    expect(res.handled).toBe(true);
    expect(res.action).toBe('incoming');
    expect(c.replies[0]?.text).toContain("yo'q");
  });

  it('rejects an unlinked telegram user', async () => {
    const c = fakeCtx(MENU.products, 999999999);
    const res = await handleMenuMessage(c);
    expect(res.handled).toBe(true);
    expect(res.action).toBe('unauthorized');
  });
});
