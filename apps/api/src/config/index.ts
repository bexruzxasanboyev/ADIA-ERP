/**
 * Typed, validated configuration loader.
 *
 * Reads environment variables (from the repo-root `.env`, loaded via dotenv)
 * and exposes a single frozen, typed `config` object. A missing required key
 * fails fast at startup with an explicit, actionable error — secrets are never
 * hard-coded (CLAUDE.md section 9).
 */
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

// The repo root holds the single shared `.env` (two levels up from apps/api).
const REPO_ROOT = resolve(process.cwd(), '../..');
loadDotenv({ path: resolve(REPO_ROOT, '.env') });
// Also try a local apps/api/.env (does not override repo-root values).
loadDotenv({ path: resolve(process.cwd(), '.env') });

export type AppConfig = {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly databaseUrl: string;
  /**
   * Allowed CORS origin for the web client (single-origin — this app is a
   * single-tenant ERP, not a public API). Defaults to the Vite dev server.
   */
  readonly webOrigin: string;
  readonly jwt: {
    readonly secret: string;
    readonly expiresInSeconds: number;
  };
  readonly poster: {
    readonly account: string;
    readonly appId: string;
    readonly appSecret: string;
    readonly token: string;
    /**
     * Shared secret embedded in the webhook URL Poster posts to. Used by the
     * `/api/integrations/poster/webhook[/:secret]` handler with a
     * constant-time compare. Empty -> the webhook endpoint refuses all calls.
     */
    readonly webhookSecret: string;
  };
  readonly telegram: {
    readonly botToken: string;
  };
  /**
   * Telegram bot identity used by the M9 outbox worker. Optional — when
   * `token` is empty the outbox worker is not started (development /
   * integration-test mode). `username` is informational (e.g. for help
   * messages and links) and never required.
   */
  readonly bot: {
    readonly token: string;
    readonly username: string;
  };
};

class ConfigError extends Error {
  public override readonly name = 'ConfigError';
}

/** Read a required env var; throw a clear error if absent or empty. */
function required(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(
      `Missing required environment variable "${key}". ` +
        `Set it in the repo-root .env file (see .env.example).`,
    );
  }
  return value.trim();
}

/** Read an optional env var, falling back to a default. */
function optional(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function parsePositiveInt(key: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`Environment variable "${key}" must be a positive integer, got "${raw}".`);
  }
  return n;
}

function parseNodeEnv(raw: string): AppConfig['nodeEnv'] {
  if (raw === 'development' || raw === 'test' || raw === 'production') {
    return raw;
  }
  throw new ConfigError(
    `NODE_ENV must be one of "development" | "test" | "production", got "${raw}".`,
  );
}

let cached: AppConfig | undefined;

/**
 * Build and validate the config once. Subsequent calls return the cache.
 * In `test` mode, DATABASE_URL falls back to a local dev database so the
 * smoke test can run without extra setup.
 */
export function loadConfig(): AppConfig {
  if (cached !== undefined) {
    return cached;
  }

  const nodeEnv = parseNodeEnv(optional('NODE_ENV', 'development'));

  // DATABASE_URL is required outside of tests; tests get a sane local default.
  const databaseUrl =
    nodeEnv === 'test'
      ? optional('DATABASE_URL', 'postgres://localhost:5432/adia_erp_dev')
      : required('DATABASE_URL');

  // JWT secret is required outside of tests; tests get a fixed dummy secret.
  const jwtSecret =
    nodeEnv === 'test' ? optional('JWT_SECRET', 'test-only-insecure-secret') : required('JWT_SECRET');

  cached = Object.freeze({
    nodeEnv,
    port: parsePositiveInt('PORT', optional('PORT', '3001')),
    databaseUrl,
    webOrigin: optional('WEB_ORIGIN', 'http://localhost:5173'),
    jwt: Object.freeze({
      secret: jwtSecret,
      expiresInSeconds: parsePositiveInt(
        'JWT_EXPIRES_IN_SECONDS',
        optional('JWT_EXPIRES_IN_SECONDS', '43200'), // 12h
      ),
    }),
    poster: Object.freeze({
      account: optional('POSTER_ACCOUNT', ''),
      appId: optional('POSTER_APP_ID', ''),
      appSecret: optional('POSTER_APP_SECRET', ''),
      token: optional('POSTER_TOKEN', ''),
      webhookSecret: optional('POSTER_WEBHOOK_SECRET', ''),
    }),
    telegram: Object.freeze({
      botToken: optional('TELEGRAM_BOT_TOKEN', ''),
    }),
    bot: Object.freeze({
      // M9 — Grammy bot token / username (see `.env` BOT_TOKEN / BOT_USERNAME).
      // Outbound-only: the outbox worker pushes Telegram messages and does NOT
      // start polling. Optional so dev / test work with an empty token.
      token: optional('BOT_TOKEN', ''),
      username: optional('BOT_USERNAME', ''),
    }),
  });

  return cached;
}

/**
 * Clear the cached config. TEST-ONLY.
 *
 * `loadConfig()` memoizes its result at module scope so the whole app sees
 * one frozen config object. Tests that need to exercise `loadConfig()` under
 * different environment variables must call this between cases to force a
 * fresh build. Production code never calls this.
 */
export function resetConfigCache(): void {
  cached = undefined;
}

export { ConfigError };
