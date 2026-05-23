import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest } from '@/lib/api-client';
import type {
  AssistantMessage,
  AssistantQueryResponse,
  AssistantSessionDetail,
  AssistantSessionSummary,
  AssistantSessionsResponse,
} from '@/lib/types';

interface ChatState {
  messages: AssistantMessage[];
  sessionId: number | null;
  isSending: boolean;
  sendError: string | null;
  sessions: AssistantSessionSummary[];
  isLoadingSessions: boolean;
  sessionsError: string | null;
}

interface ChatApi extends ChatState {
  send: (text: string) => Promise<void>;
  startNewSession: () => void;
  openSession: (id: number) => Promise<void>;
  reloadSessions: () => void;
  /** Clears any in-flight send error so the next attempt isn't blocked visually. */
  clearError: () => void;
}

/**
 * Maps a backend `ApiError` to a user-facing Uzbek message.
 *
 * Special-cases the Vertex outage codes called out in the brief — if the
 * backend can't reach Gemini, we don't want to surface a raw "503" to a
 * store manager.
 */
function localiseError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'VERTEX_UNAVAILABLE' || err.status === 503) {
      return 'AI yordamchi vaqtinchalik mavjud emas. Birozdan keyin qayta urinib ko‘ring.';
    }
    if (err.code === 'RATE_LIMITED' || err.status === 429) {
      return 'So‘rovlar juda tez yuborildi. Bir daqiqa kuting va qayta urinib ko‘ring.';
    }
    if (err.code === 'AI_INSUFFICIENT_CONTEXT') {
      return 'Savol juda noaniq — iltimos, batafsilroq yozing.';
    }
    return err.message;
  }
  return 'Kutilmagan xato yuz berdi.';
}

/**
 * Stateful AI-chat hook used by `AssistantDrawer`.
 *
 * Lifecycle:
 *  - On mount (or when `enabled` flips true) — fetch the session list.
 *  - First `send` creates a new server-side session; the response's
 *    `session_id` is captured and reused for follow-ups.
 *  - `startNewSession` resets local state (no server call needed; the
 *    server creates a fresh row on the next `send`).
 *  - `openSession` loads `/api/assistant/sessions/:id` and rehydrates
 *    `messages` from the audit trail.
 */
export function useAssistantChat(enabled: boolean): ChatApi {
  const [state, setState] = useState<ChatState>({
    messages: [],
    sessionId: null,
    isSending: false,
    sendError: null,
    sessions: [],
    isLoadingSessions: false,
    sessionsError: null,
  });

  // Live mirror of `sessionId` for the async `send` flow — avoids the
  // stale-closure pitfall when `send` is dispatched twice in quick
  // succession before React has flushed the previous setState.
  const sessionIdRef = useRef<number | null>(null);
  useEffect(() => {
    sessionIdRef.current = state.sessionId;
  }, [state.sessionId]);

  const reloadSessions = useCallback(() => {
    setState((s) => ({ ...s, isLoadingSessions: true, sessionsError: null }));
    apiRequest<AssistantSessionsResponse>(
      '/api/assistant/sessions?limit=30&offset=0',
    )
      .then((res) => {
        setState((s) => ({
          ...s,
          sessions: res.items,
          isLoadingSessions: false,
        }));
      })
      .catch((err) => {
        setState((s) => ({
          ...s,
          isLoadingSessions: false,
          sessionsError: localiseError(err),
        }));
      });
  }, []);

  // Lazy-load the sessions list — only when the drawer is first opened.
  useEffect(() => {
    if (enabled && state.sessions.length === 0 && !state.isLoadingSessions) {
      reloadSessions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const send = useCallback(async (text: string) => {
    const now = new Date().toISOString();
    const userMessage: AssistantMessage = {
      role: 'user',
      content: text,
      created_at: now,
    };
    setState((s) => ({
      ...s,
      messages: [...s.messages, userMessage],
      isSending: true,
      sendError: null,
    }));

    try {
      const body: { session_id?: number; message: string } = { message: text };
      const currentSessionId = sessionIdRef.current;
      if (currentSessionId !== null) body.session_id = currentSessionId;

      const result = await apiRequest<AssistantQueryResponse>(
        '/api/assistant/query',
        { method: 'POST', body },
      );

      const assistantMessage: AssistantMessage = {
        role: 'assistant',
        content: result.response,
        tool_calls: result.tool_calls,
        created_at: new Date().toISOString(),
      };
      setState((s) => ({
        ...s,
        messages: [...s.messages, assistantMessage],
        sessionId: result.session_id,
        isSending: false,
        // Refresh sessions list so the new title shows up at the top.
        sessions: upsertSessionAtTop(s.sessions, {
          id: result.session_id,
          title:
            s.sessions.find((x) => x.id === result.session_id)?.title ??
            truncateTitle(text),
          updated_at: assistantMessage.created_at,
        }),
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        isSending: false,
        sendError: localiseError(err),
      }));
    }
  }, []);

  const startNewSession = useCallback(() => {
    setState((s) => ({
      ...s,
      messages: [],
      sessionId: null,
      sendError: null,
    }));
  }, []);

  const openSession = useCallback(async (id: number) => {
    setState((s) => ({
      ...s,
      isSending: true,
      sendError: null,
      sessionId: id,
      messages: [],
    }));
    try {
      const detail = await apiRequest<AssistantSessionDetail>(
        `/api/assistant/sessions/${id}`,
      );
      setState((s) => ({
        ...s,
        messages: detail.messages,
        sessionId: detail.session.id,
        isSending: false,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        isSending: false,
        sendError: localiseError(err),
      }));
    }
  }, []);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, sendError: null }));
  }, []);

  return {
    ...state,
    send,
    startNewSession,
    openSession,
    reloadSessions,
    clearError,
  };
}

function upsertSessionAtTop(
  current: AssistantSessionSummary[],
  next: AssistantSessionSummary,
): AssistantSessionSummary[] {
  const without = current.filter((s) => s.id !== next.id);
  return [next, ...without];
}

function truncateTitle(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length <= 40) return trimmed;
  return `${trimmed.slice(0, 40)}…`;
}
