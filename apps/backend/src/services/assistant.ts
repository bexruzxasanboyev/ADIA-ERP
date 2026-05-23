/**
 * AI assistant service (ADR-0006, spec §3 / §7.4 — Phase-2 F2.2).
 *
 * One entrypoint: `runAssistantQuery({ sessionId?, message, principal, client? })`.
 *
 * Flow:
 *   1. Resolve (or create) an `assistant_sessions` row. RBAC is enforced —
 *      the principal can only attach to a session they own.
 *   2. Persist the user's message (`role='user'`).
 *   3. Build the Vertex round-trip: system instruction (`buildSystemPrompt`)
 *      + the trailing N turns from the message history + tool declarations.
 *   4. Multi-turn loop — if the model returns one or more `functionCall`
 *      parts, execute each tool server-side, append a `functionResponse`
 *      to the contents, and round-trip again. Capped by
 *      `cfg.vertex.maxToolCallsPerTurn`.
 *   5. Persist the final assistant message with the ordered tool-call audit
 *      (`{name, args, ok}` per call), plus one row per tool execution
 *      (`role='tool'`).
 *   6. Audit-log the whole exchange (`entity='assistant_query'`).
 *   7. Return the response shape the frontend expects:
 *      `{ session_id, response, tool_calls: [{tool_name, args, result_summary}] }`.
 *
 * Invariants (Phase-2):
 *   * Every persisted row lives inside the calling user's session — RBAC.
 *   * No write tools — the entire surface is read-only. Tool args are
 *     validated inside each executor.
 *   * The model has zero authority over RBAC scope (see `tools.ts`).
 */
import { withTransaction, query, type SqlParam, type TxClient } from '../db/index.js';
import { writeAudit } from '../lib/audit.js';
import { AppError } from '../errors/index.js';
import type { AuthPrincipal } from '../auth/jwt.js';
import { buildSystemPrompt } from '../integrations/vertex/systemPrompt.js';
import {
  defaultVertexClient,
  type VertexClient,
} from '../integrations/vertex/client.js';
import {
  getToolExecutor,
  toolDeclarations,
  type ToolRow,
} from '../integrations/vertex/tools.js';
import { loadConfig } from '../config/index.js';
import type {
  Content,
  FunctionCall,
  GenerateContentResponse,
  Part,
} from '@google/genai';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/** Tool-call entry exposed to the frontend (one per executed tool). */
export type AssistantToolCallView = {
  readonly tool_name: string;
  readonly args: Record<string, unknown>;
  readonly result_summary: string;
};

export type RunAssistantQueryInput = {
  /** Optional — resume an existing session; omit to start a new one. */
  readonly sessionId?: number;
  /** The user's question. Non-empty (validated at the route boundary). */
  readonly message: string;
  /** The authenticated principal — sets system-prompt + tool RBAC scope. */
  readonly principal: AuthPrincipal;
  /**
   * Test-only override. Production callers omit it and get the real Vertex
   * client; tests pass a fake that returns canned responses.
   */
  readonly client?: VertexClient;
};

export type RunAssistantQueryResult = {
  readonly session_id: number;
  readonly response: string;
  readonly tool_calls: AssistantToolCallView[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max prior turns we feed back into the model (keeps token cost bounded). */
const HISTORY_TURN_LIMIT = 20;

/** Cap on the summary string we expose per tool call (UI is space-bound). */
const RESULT_SUMMARY_MAX_LEN = 200;

/** Title derived from the first user message — keep the UI sidebar tidy. */
const SESSION_TITLE_MAX_LEN = 40;

/**
 * Heuristic chars-per-token used to bound the user's raw message length.
 * Gemini tokenisation isn't 1:1 with bytes, but for Cyrillic/Latin Uzbek text
 * ~3 chars/token is a safe upper bound. We multiply `cfg.vertex.maxInputTokens`
 * by this to compute a character cap and reject the request at the boundary
 * before paying for a Vertex round-trip.
 */
const MESSAGE_CHARS_PER_TOKEN = 3;

/**
 * Max characters of the final assistant response stored in the audit payload.
 * Truncated to keep audit rows bounded — full text still lives in
 * `assistant_messages.content` for the session view.
 */
const AUDIT_RESPONSE_TEXT_MAX_LEN = 1000;

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

type SessionRow = {
  readonly id: string;
  readonly user_id: string;
  readonly title: string | null;
};

type MessageRow = {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly tool_name: string | null;
  readonly tool_payload: unknown;
  readonly tool_result: unknown;
};

/** A single executed tool turn — captured for both the DB row and the API view. */
type ExecutedToolCall = {
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** True when execution succeeded; false when it threw. */
  readonly ok: boolean;
  /** Raw tool output (rows, or `{ error: string }` on failure). */
  readonly result: unknown;
  /** Short human-readable summary for the API view. */
  readonly summary: string;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAssistantQuery(
  input: RunAssistantQueryInput,
): Promise<RunAssistantQueryResult> {
  const client = input.client ?? defaultVertexClient;
  if (!client.enabled) {
    // The route translates this into a 503 — surfacing the same shape lets
    // the unit test assert the failure mode without touching HTTP.
    throw AppError.internal('VERTEX_UNAVAILABLE');
  }

  const principal = input.principal;
  const message = input.message.trim();
  if (message === '') {
    throw AppError.validation('Field "message" must be a non-empty string.');
  }

  // Token-budget guard — reject obviously oversize messages BEFORE we touch
  // the DB or Vertex. The cap is derived from `cfg.vertex.maxInputTokens`
  // using a conservative chars-per-token ratio so the model has headroom
  // for the system prompt + tool declarations + history.
  const cfg = loadConfig();
  const maxMessageChars = cfg.vertex.maxInputTokens * MESSAGE_CHARS_PER_TOKEN;
  if (message.length > maxMessageChars) {
    throw AppError.validation(
      `Xabar juda uzun (max ~${maxMessageChars} belgi).`,
    );
  }

  // Wall-clock latency for the audit payload (spec §2.2).
  const startedAt = Date.now();

  // 1. Resolve or create the session. RBAC is enforced here.
  const session = await resolveSession(input.sessionId, message, principal);

  // 2. Persist the user message.
  await insertUserMessage(session.id, message);

  // 3. Build the running conversation (history + new turn).
  const history = await loadHistory(session.id);
  const contents: Content[] = historyToContents(history);

  // 4. Multi-turn tool loop.
  const systemInstruction = buildSystemPrompt(principal);
  const tools = toolDeclarations();
  const executedTools: ExecutedToolCall[] = [];

  let finalText = '';
  for (let turn = 0; turn <= cfg.vertex.maxToolCallsPerTurn; turn += 1) {
    const response: GenerateContentResponse = await client.generate({
      systemInstruction,
      contents,
      tools,
    });
    const candidate = response.candidates?.[0];
    if (candidate === undefined) {
      // Safety block or empty response — surface gracefully, no crash.
      finalText = 'Ma\'lumot mavjud emas.';
      break;
    }
    const parts = candidate.content?.parts ?? [];
    const functionCalls = collectFunctionCalls(parts);

    if (functionCalls.length === 0) {
      finalText = collectText(parts);
      // Append the model's final turn to `contents` so we can persist it
      // honestly (and so the loop's terminal condition is explicit).
      contents.push({ role: 'model', parts });
      break;
    }

    // The model wants to call tools. Echo the model turn into `contents`
    // and append a `functionResponse` part for each call.
    contents.push({ role: 'model', parts });

    if (turn === cfg.vertex.maxToolCallsPerTurn) {
      // We've already executed the maximum permitted chain — refuse to
      // dispatch yet more tool calls. Return the fallback message.
      finalText =
        'Tool zanjir chegarasiga yetdi — savol juda murakkab. Iltimos, ' +
        'savolni qisqaroq qismlarga bo\'ling.';
      break;
    }

    const responseParts: Part[] = [];
    for (const call of functionCalls) {
      const executed = await executeOneToolCall(call, principal);
      executedTools.push(executed);
      responseParts.push({
        functionResponse: {
          name: executed.name,
          response: executed.ok
            ? { result: executed.result }
            : { error: (executed.result as { error: string }).error },
        },
      });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  // 5. Persist tool rows + final assistant message + audit, all atomically.
  const latencyMs = Date.now() - startedAt;
  await persistTurn({
    sessionId: session.id,
    userMessage: message,
    finalText,
    executedTools,
    principal,
    latencyMs,
  });

  // 6. Build the API-facing tool-call list (transform DB shape -> view shape).
  const toolCallsView: AssistantToolCallView[] = executedTools.map((t) => ({
    tool_name: t.name,
    args: t.args,
    result_summary: t.summary,
  }));

  return {
    session_id: session.id,
    response: finalText,
    tool_calls: toolCallsView,
  };
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

type ResolvedSession = { readonly id: number };

async function resolveSession(
  sessionId: number | undefined,
  message: string,
  principal: AuthPrincipal,
): Promise<ResolvedSession> {
  if (sessionId !== undefined) {
    const { rows } = await query<SessionRow>(
      `SELECT id, user_id, title FROM assistant_sessions WHERE id = $1`,
      [sessionId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw AppError.notFound('Assistant session not found.');
    }
    if (Number(row.user_id) !== principal.userId) {
      throw AppError.forbidden('You may only access your own assistant sessions.');
    }
    // Bump updated_at so the sidebar order reflects this turn.
    await query(
      `UPDATE assistant_sessions SET updated_at = now() WHERE id = $1`,
      [sessionId],
    );
    return { id: Number(row.id) };
  }
  // New session — derive a short title from the first user message.
  const title = message.slice(0, SESSION_TITLE_MAX_LEN).trim();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO assistant_sessions (user_id, title)
     VALUES ($1, $2)
     RETURNING id`,
    [principal.userId, title],
  );
  const idRaw = rows[0]?.id;
  if (idRaw === undefined) {
    throw AppError.internal('Failed to create assistant session.');
  }
  return { id: Number(idRaw) };
}

async function insertUserMessage(sessionId: number, content: string): Promise<void> {
  await query(
    `INSERT INTO assistant_messages (session_id, role, content)
     VALUES ($1, 'user', $2)`,
    [sessionId, content],
  );
}

/**
 * Pull the most recent N turns for the session (chronological). We
 * intentionally do NOT replay tool rows back to the model — the model only
 * needs the user/assistant text exchange; tool calls/responses live in the
 * audit history and are reconstructed implicitly by the model from text.
 */
async function loadHistory(sessionId: number): Promise<MessageRow[]> {
  const { rows } = await query<MessageRow>(
    `SELECT role, content, tool_name, tool_payload, tool_result
       FROM assistant_messages
      WHERE session_id = $1
        AND role IN ('user','assistant')
      ORDER BY id DESC
      LIMIT $2`,
    [sessionId, HISTORY_TURN_LIMIT],
  );
  return rows.reverse();
}

function historyToContents(rows: readonly MessageRow[]): Content[] {
  return rows.map((row) => ({
    role: row.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: row.content }],
  }));
}

// ---------------------------------------------------------------------------
// Vertex part helpers
// ---------------------------------------------------------------------------

function collectFunctionCalls(parts: readonly Part[]): FunctionCall[] {
  const calls: FunctionCall[] = [];
  for (const part of parts) {
    if ('functionCall' in part && part.functionCall !== undefined) {
      calls.push(part.functionCall);
    }
  }
  return calls;
}

function collectText(parts: readonly Part[]): string {
  let text = '';
  for (const part of parts) {
    if ('text' in part && typeof part.text === 'string') {
      text += part.text;
    }
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeOneToolCall(
  call: FunctionCall,
  principal: AuthPrincipal,
): Promise<ExecutedToolCall> {
  // `FunctionCall.name` is optional in the @google/genai types; treat a
  // missing name as an unknown tool (the model is free to misbehave, we
  // don't crash).
  const name = call.name ?? '';
  const args = (call.args ?? {}) as Record<string, unknown>;
  const executor = name === '' ? undefined : getToolExecutor(name);
  if (executor === undefined) {
    const summary = `Unknown tool "${name}".`;
    return { name, args, ok: false, result: { error: summary }, summary };
  }
  try {
    const rows = await executor.execute(args, principal);
    const summary = summariseToolResult(name, rows);
    return { name, args, ok: true, result: rows, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name,
      args,
      ok: false,
      result: { error: message },
      summary: clip(`error: ${message}`, RESULT_SUMMARY_MAX_LEN),
    };
  }
}

/**
 * Build a short, deterministic, UI-friendly summary of a tool's row list.
 * The frontend renders this verbatim in the "what the AI looked up" chip; it
 * must be short and never leak unexpected free-text from arbitrary columns.
 */
function summariseToolResult(name: string, rows: readonly ToolRow[]): string {
  const count = rows.length;
  if (count === 0) {
    return clip(`${name}: 0 satr`, RESULT_SUMMARY_MAX_LEN);
  }
  const preview = previewFields(name, rows[0]!);
  const base = preview === ''
    ? `${name}: ${count} satr`
    : `${name}: ${count} satr · ${preview}`;
  return clip(base, RESULT_SUMMARY_MAX_LEN);
}

/** Pick a few representative fields from the first row for a quick preview. */
function previewFields(toolName: string, row: ToolRow): string {
  const fields: string[] = [];
  const keys =
    toolName === 'get_sales_summary'
      ? ['product_name', 'qty_sold', 'revenue']
      : toolName === 'get_recent_movements'
        ? ['product_name', 'qty', 'reason']
        : toolName === 'get_open_requests'
          ? ['product_name', 'qty_needed', 'status']
          : toolName === 'get_production_plan'
            ? ['product_name', 'qty', 'status']
            : ['product_name', 'qty', 'min_level'];
  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null) {
      continue;
    }
    fields.push(`${key}=${String(value)}`);
  }
  return fields.join(', ');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Persistence + audit
// ---------------------------------------------------------------------------

type PersistTurnInput = {
  readonly sessionId: number;
  readonly userMessage: string;
  readonly finalText: string;
  readonly executedTools: readonly ExecutedToolCall[];
  readonly principal: AuthPrincipal;
  readonly latencyMs: number;
};

async function persistTurn(input: PersistTurnInput): Promise<void> {
  const toolCallsJson = input.executedTools.map((t) => ({
    name: t.name,
    args: t.args,
    ok: t.ok,
  }));
  // Ordered list of distinct tool names actually executed — useful for
  // metrics/dashboards (spec §2.2) without re-deriving from `tool_calls`.
  const toolsUsed = input.executedTools.map((t) => t.name);

  await withTransaction(async (tx: TxClient) => {
    // One `role='tool'` row per executed tool, in execution order.
    for (const t of input.executedTools) {
      await tx.query(
        `INSERT INTO assistant_messages
           (session_id, role, content, tool_name, tool_payload, tool_result)
         VALUES ($1, 'tool', $2, $3, $4, $5)`,
        [
          input.sessionId,
          `${t.name} ${t.ok ? 'executed' : 'failed'}`,
          t.name,
          jsonOrNull(t.args),
          jsonOrNull(t.result),
        ],
      );
    }
    // The final assistant turn.
    await tx.query(
      `INSERT INTO assistant_messages (session_id, role, content, tool_calls)
       VALUES ($1, 'assistant', $2, $3)`,
      [
        input.sessionId,
        input.finalText,
        toolCallsJson.length === 0 ? null : jsonOrNull(toolCallsJson),
      ],
    );
    // Bump session updated_at for the sidebar ordering.
    await tx.query(
      `UPDATE assistant_sessions SET updated_at = now() WHERE id = $1`,
      [input.sessionId],
    );
    // Audit — one summary row per query. Spec §2.2 requires the user
    // question, the assistant response (truncated), and observed latency in
    // addition to the tool-call audit. `response_text` is clipped to
    // AUDIT_RESPONSE_TEXT_MAX_LEN so audit rows stay bounded (full text is
    // already in `assistant_messages.content`).
    await writeAudit(tx, {
      actorUserId: input.principal.userId,
      action: 'assistant_query.run',
      entity: 'assistant_query',
      entityId: input.sessionId,
      payload: {
        session_id: input.sessionId,
        user_question: input.userMessage,
        tool_calls: toolCallsJson,
        tools_used: toolsUsed,
        response_text: clip(input.finalText, AUDIT_RESPONSE_TEXT_MAX_LEN),
        response_chars: input.finalText.length,
        latency_ms: input.latencyMs,
      },
    });
  });
}

/** Encode a value as JSON (for JSONB columns). `null` stays `null`. */
function jsonOrNull(value: unknown): SqlParam {
  if (value === null || value === undefined) {
    return null;
  }
  return JSON.stringify(value) as unknown as SqlParam;
}

// ---------------------------------------------------------------------------
// Read helpers used by the routes (list sessions / one session)
// ---------------------------------------------------------------------------

export type SessionListItem = {
  readonly id: number;
  readonly title: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export async function listSessionsForUser(
  userId: number,
  limit: number,
  offset: number,
): Promise<{ items: SessionListItem[]; total: number }> {
  const [pageRes, totalRes] = await Promise.all([
    query<{
      id: string;
      title: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, title, created_at, updated_at
         FROM assistant_sessions
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    ),
    query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM assistant_sessions WHERE user_id = $1`,
      [userId],
    ),
  ]);
  const items = pageRes.rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }));
  const total = Number(totalRes.rows[0]?.cnt ?? '0');
  return { items, total };
}

export type SessionDetail = {
  readonly session: {
    id: number;
    title: string | null;
    created_at: string;
    updated_at: string;
  };
  readonly messages: ReadonlyArray<{
    id: number;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls: AssistantToolCallView[] | null;
    tool_name: string | null;
    created_at: string;
  }>;
};

/**
 * Read one session and its messages. RBAC is enforced: a caller may only
 * read sessions they own. Returns `null` when the session does not exist.
 */
export async function getSessionForCaller(
  sessionId: number,
  principal: AuthPrincipal,
): Promise<SessionDetail | null> {
  const { rows: sessRows } = await query<{
    id: string;
    user_id: string;
    title: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, user_id, title, created_at, updated_at
       FROM assistant_sessions WHERE id = $1`,
    [sessionId],
  );
  const sess = sessRows[0];
  if (sess === undefined) {
    return null;
  }
  if (Number(sess.user_id) !== principal.userId) {
    throw AppError.forbidden('You may only access your own assistant sessions.');
  }
  const { rows: msgRows } = await query<{
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls: unknown;
    tool_name: string | null;
    tool_payload: unknown;
    tool_result: unknown;
    created_at: Date;
  }>(
    `SELECT id, role, content, tool_calls, tool_name, tool_payload, tool_result, created_at
       FROM assistant_messages
      WHERE session_id = $1
      ORDER BY id`,
    [sessionId],
  );

  return {
    session: {
      id: Number(sess.id),
      title: sess.title,
      created_at: sess.created_at.toISOString(),
      updated_at: sess.updated_at.toISOString(),
    },
    messages: msgRows.map((r) => ({
      id: Number(r.id),
      role: r.role,
      content: r.content,
      tool_calls: dbToolCallsToView(r.tool_calls),
      tool_name: r.tool_name,
      created_at: r.created_at.toISOString(),
    })),
  };
}

/**
 * Transform the on-disk `{name, args, ok}[]` JSONB shape into the
 * `{tool_name, args, result_summary}[]` view shape. For historical rows we
 * never persisted `result_summary` separately, so we recompute a minimal
 * summary from `ok` — good enough for the sidebar's tool chip.
 */
function dbToolCallsToView(value: unknown): AssistantToolCallView[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((raw) => {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name : 'unknown';
    const args = (obj.args ?? {}) as Record<string, unknown>;
    const ok = obj.ok === true;
    return {
      tool_name: name,
      args,
      result_summary: ok ? `${name}: ok` : `${name}: failed`,
    };
  });
}
