/**
 * AI chat in Telegram — the web assistant reused from the bot.
 *
 * Proves:
 *   1. A free-text message routes to the assistant with the user's REAL
 *      principal and the bot replies with the assistant's answer.
 *   2. A menu button still routes to the menu (handled there), NOT to AI.
 *   3. A proposed WRITE action is rendered as a note, not auto-executed.
 *   4. An assistant/Vertex failure produces a graceful Uzbek error reply.
 *
 * The assistant service is INJECTED via `AiChatDeps`, so no Vertex/DB round
 * trip is needed — the test asserts the exact `{ message, principal }` passed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '../src/auth/jwt.js';
import type {
  RunAssistantQueryInput,
  RunAssistantQueryResult,
} from '../src/services/assistant.js';
import {
  handleAiChatMessage,
  isInAiChatMode,
  enterAiChatMode,
  exitAiChatMode,
  __resetAiChatModeForTesting,
  type AiChatCtxLike,
  type AiChatDeps,
} from '../src/integrations/telegram/aiChatHandler.js';
import {
  isMenuButton,
  MENU,
} from '../src/integrations/telegram/menuHandler.js';

const STORE_PRINCIPAL: AuthPrincipal = {
  userId: 42,
  role: 'store_manager',
  locationId: 7,
  locationIds: [7],
  activeLocationId: 7,
};

const TG_ID = 555001;

afterEach(() => {
  __resetAiChatModeForTesting();
  vi.restoreAllMocks();
});

function fakeCtx(
  text: string,
  id: number = TG_ID,
): AiChatCtxLike & {
  replies: Array<{ text: string; opts?: Record<string, unknown> }>;
  chatActions: string[];
} {
  const replies: Array<{ text: string; opts?: Record<string, unknown> }> = [];
  const chatActions: string[] = [];
  return {
    from: { id },
    message: { text },
    replies,
    chatActions,
    async reply(t: string, opts?: Record<string, unknown>) {
      replies.push({ text: t, opts });
      return undefined;
    },
    async replyWithChatAction(action: string) {
      chatActions.push(action);
      return undefined;
    },
  };
}

describe('handleAiChatMessage — AI chat reuses the web assistant', () => {
  it('sends free text to the assistant with the user real principal and replies with its answer', async () => {
    const runAssistant = vi.fn(
      async (_input: RunAssistantQueryInput): Promise<RunAssistantQueryResult> => {
        return {
          session_id: 1,
          response: 'Bugun Kukchada НАПОЛЕОН eng ko\'p sotildi.',
          tool_calls: [],
        };
      },
    );
    const deps: AiChatDeps = {
      loadPrincipal: vi.fn(async () => STORE_PRINCIPAL),
      runAssistant,
    };

    const ctx = fakeCtx("bugun Кукчada nima ko'p sotildi?");
    const res = await handleAiChatMessage(ctx, deps);

    expect(res.handled).toBe(true);
    expect(res.reason).toBe('answered');

    // Assistant invoked with the user message + their REAL principal (RBAC scope).
    expect(runAssistant).toHaveBeenCalledTimes(1);
    const arg = runAssistant.mock.calls[0]![0];
    expect(arg.message).toBe("bugun Кукчada nima ko'p sotildi?");
    expect(arg.principal).toEqual(STORE_PRINCIPAL);

    // Typing indicator shown, answer relayed verbatim.
    expect(ctx.chatActions).toContain('typing');
    expect(ctx.replies.at(-1)?.text).toContain('НАПОЛЕОН');
  });

  it('renders a proposed WRITE action as a note and does NOT auto-execute', async () => {
    const deps: AiChatDeps = {
      loadPrincipal: vi.fn(async () => STORE_PRINCIPAL),
      runAssistant: vi.fn(async () => ({
        session_id: 1,
        response: 'Tushundim.',
        tool_calls: [],
        pending_action: {
          action_id: 9,
          tool_name: 'create_request',
          args: {},
          summary: 'NAPOLEON 20 dona so\'rovi',
          expires_at: new Date().toISOString(),
        },
      })),
    };
    const ctx = fakeCtx('menga yigirmata napoleon kerak');
    const res = await handleAiChatMessage(ctx, deps);
    expect(res.handled).toBe(true);
    const reply = ctx.replies.at(-1)?.text ?? '';
    expect(reply).toContain('Tushundim.');
    expect(reply).toContain('avtomatik bajarilmaydi');
  });

  it('replies gracefully when the assistant throws (Vertex down)', async () => {
    const deps: AiChatDeps = {
      loadPrincipal: vi.fn(async () => STORE_PRINCIPAL),
      runAssistant: vi.fn(async () => {
        throw new Error('VERTEX_UNAVAILABLE');
      }),
    };
    const ctx = fakeCtx('savol?');
    const res = await handleAiChatMessage(ctx, deps);
    expect(res.handled).toBe(true);
    expect(res.reason).toBe('assistant_error');
    expect(ctx.replies.at(-1)?.text).toContain('AI hozir javob berolmadi');
  });

  it('rejects an unlinked telegram user before calling the assistant', async () => {
    const runAssistant = vi.fn();
    const deps: AiChatDeps = {
      loadPrincipal: vi.fn(async () => null),
      runAssistant,
    };
    const ctx = fakeCtx('savol?');
    const res = await handleAiChatMessage(ctx, deps);
    expect(res.handled).toBe(true);
    expect(res.reason).toBe('unauthorized');
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it('ignores empty / id-less input (falls through, handled=false)', async () => {
    const deps: AiChatDeps = {
      loadPrincipal: vi.fn(),
      runAssistant: vi.fn(),
    };
    const res = await handleAiChatMessage(
      { from: { id: TG_ID }, message: { text: '   ' }, async reply() {} },
      deps,
    );
    expect(res.handled).toBe(false);
    expect(deps.loadPrincipal).not.toHaveBeenCalled();
  });
});

describe('AI-chat mode flag', () => {
  it('enter/exit/isInAiChatMode round-trips', () => {
    expect(isInAiChatMode(TG_ID)).toBe(false);
    enterAiChatMode(TG_ID);
    expect(isInAiChatMode(TG_ID)).toBe(true);
    exitAiChatMode(TG_ID);
    expect(isInAiChatMode(TG_ID)).toBe(false);
  });
});

describe('precedence — a menu button still routes to the menu, NOT to AI', () => {
  // bot.ts runs `handleMenuMessage` FIRST and `return`s when it reports
  // `handled:true`; the AI path is only reached for NON-menu free text. The
  // gate `handleMenuMessage` uses to claim a message is `isMenuButton`, so a
  // recognised button can never fall through to the assistant.
  it('every menu label (incl. AI suhbat) is recognised by the menu router gate', () => {
    for (const label of Object.values(MENU)) {
      expect(isMenuButton(label)).toBe(true);
    }
  });

  it('free-text questions are NOT menu buttons (so they fall through to AI)', () => {
    expect(isMenuButton("bugun Кукчada nima ko'p sotildi?")).toBe(false);
    expect(isMenuButton('napoleon qancha qoldi?')).toBe(false);
  });
});
