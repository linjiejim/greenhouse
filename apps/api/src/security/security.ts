import { extensionRateLimit } from './extension-rate-limits.js';
/**
 * Security middleware — rate limiting, security headers, input validation.
 *
 * Provides defense-in-depth for an internet-reachable internal deployment:
 * - IP- and user-based rate limiting (per endpoint, counters shared in the database)
 * - Standard security response headers
 * - Profile access control enforcement
 */

import type { Context, Next } from 'hono';
import { getDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { getRequestSourceIp } from './request-ip.js';

// ─── Rate Limiter ────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in this window after this one (0 once exceeded). */
  remaining: number;
  /** Epoch ms when the window ends. */
  resetAt: number;
}

const FAIL_OPEN_WARN_INTERVAL_MS = 60_000;
let lastFailOpenWarnAt = 0;
let failOpenSinceWarn = 0;

/**
 * Count one request against `key` in a fixed window and say whether it is within
 * `maxRequests`. The counter lives in `rate_limit_buckets` (one atomic
 * upsert-increment per call, bucket key `<key>:<window start ms>`), so a restart
 * does not reset it and every instance shares it. Windows are aligned to the
 * epoch (a 60s window starts on the minute, a day window at 00:00 UTC).
 *
 * **Fails open.** If the database call fails the request is allowed and a
 * warning is logged (at most once a minute, with a count of what was let
 * through). These limits are abuse brakes, not authorization: every route behind
 * them still authenticates and authorizes against the same database, so during
 * an outage a closed limiter would add nothing but a second reason to refuse —
 * and a brief blip on the counter table alone would otherwise turn into a 429 for
 * every user at once. The secrets these limits slow down (login passwords aside,
 * which also have account lockout) are long random values.
 */
export async function checkRateLimit(
  key: string,
  windowMs: number,
  maxRequests: number,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;
  try {
    const count = await getDb().rateLimits.hit(`${key}:${windowStart}`, new Date(resetAt).toISOString());
    return { allowed: count <= maxRequests, remaining: Math.max(0, maxRequests - count), resetAt };
  } catch (error) {
    failOpenSinceWarn += 1;
    if (now - lastFailOpenWarnAt >= FAIL_OPEN_WARN_INTERVAL_MS) {
      logger.warn('[rate-limit] counter unavailable, allowing requests (fail-open)', {
        error: toErrorMessage(error),
        allowedSinceLastWarning: failOpenSinceWarn,
      });
      lastFailOpenWarnAt = now;
      failOpenSinceWarn = 0;
    }
    return { allowed: true, remaining: Math.max(0, maxRequests - 1), resetAt };
  }
}

/** Test hook: forget the fail-open log throttle. */
export function _resetRateLimitWarnings(): void {
  lastFailOpenWarnAt = 0;
  failOpenSinceWarn = 0;
}

// ─── CORS ────────────────────────────────────────────────

const DEFAULT_CORS_ORIGINS = [
  'tauri://localhost',
  // Production web app / backend origin
  'https://greenhouse.example.com',
  // Local dev
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  // Vite dev server. A browser at :3100 normally reaches the API through Vite's
  // proxy (same-origin); a build with GREENHOUSE_API_BASE_URL pointed elsewhere
  // makes those calls genuinely cross-origin.
  'http://localhost:3100',
  'http://127.0.0.1:3100',
  // Expo Web mobile client uses a fixed dev port. Keep both loopback spellings
  // explicit so nearby ports and non-loopback hosts remain denied.
  'http://localhost:8090',
  'http://127.0.0.1:8090',
];

function getAllowedCorsOrigins(): Set<string> {
  const fromEnv = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_CORS_ORIGINS, ...fromEnv]);
}

function isAllowedCorsOrigin(origin: string): boolean {
  if (!origin) return false;
  return getAllowedCorsOrigins().has(origin);
}

/**
 * Allow cross-origin API access only from approved internal web/dev origins.
 * Bearer authentication does not require cookie credentials.
 */
export async function corsMiddleware(c: Context, next: Next) {
  const origin = c.req.header('Origin') || '';
  // The model gateway is for agents and scripts, never a browser page: no
  // origin is allowed there, so a page can never spend a member's key.
  const closed = c.req.path.startsWith('/api/gateway/');
  const allowed = !closed && origin && isAllowedCorsOrigin(origin);

  if (allowed) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    c.header(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-Workspace-Id, X-Requested-With, X-Greenhouse-Client',
    );
    c.header('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
    c.header('Access-Control-Max-Age', '86400');
  }
  c.header('Vary', 'Origin');

  if (c.req.method === 'OPTIONS') {
    return c.body(null, allowed ? 204 : 403);
  }

  return next();
}

// ─── Rate Limit Config ───────────────────────────────────

interface RateLimitConfig {
  windowMs: number;
  max: number;
}

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  '/api/auth/password-link': { windowMs: 5 * 60_000, max: 20 }, // public IP boundary; token limiter is route-local
  // Token refresh presents a long random secret, not a guessable password: every tab refreshes
  // on its own schedule, and a whole office may share one source IP.
  '/api/auth/refresh': { windowMs: 5 * 60_000, max: 60 },
  '/api/auth': { windowMs: 5 * 60_000, max: 10 }, // 10 attempts per 5 min
  // Run control (probe/list/attach/stop) is cheap registry access, not LLM
  // spend — auto-resume retries and multi-tab attaches must not eat the chat
  // message budget. Must stay ABOVE '/api/chat': first prefix match wins.
  '/api/chat/runs': { windowMs: 60_000, max: 60 },
  '/api/chat': { windowMs: 60_000, max: 15 }, // 15 messages per min (overridden for internal)
  '/oauth/register': { windowMs: 60 * 60_000, max: 10 }, // bound anonymous dynamic client registration
  '/oauth/token': { windowMs: 60_000, max: 60 }, // bound anonymous code/refresh credential attempts
  '/oauth/revoke': { windowMs: 60_000, max: 60 }, // bound anonymous revocation probing
  // One write per page view; a generous ceiling keeps a looping client from
  // turning the counter table into a write hotspot.
  '/api/usage': { windowMs: 60_000, max: 240 },
  // The public connector OAuth callback (a browser redirect from a provider); it
  // only redirects back to the app, but it decrypts a state on every hit.
  '/api/connectors/oauth/callback': { windowMs: 60_000, max: 30 },
  // Other authenticated or independently guarded endpoints are intentionally unthrottled here.
};

// Internal users get higher limits
const INTERNAL_RATE_LIMITS: Record<string, RateLimitConfig> = {
  '/api/chat/runs': { windowMs: 60_000, max: 120 }, // run control for internal users
  '/api/chat': { windowMs: 60_000, max: 30 }, // 30 messages per min for internal users
};

/**
 * Authenticated session reads that live under `/api/auth` but are not credential attempts: every
 * page load and every tab asks `/me` (and its `/me/*` siblings). Throttling them with the login
 * budget signed people out after ten reloads per source IP — a valid token is their guard, like
 * every other authenticated endpoint.
 */
const UNTHROTTLED_PREFIXES = ['/api/auth/me'] as const;

function matchRateLimit(path: string): RateLimitConfig | null {
  const contributed = extensionRateLimit(path);
  if (contributed) return contributed;
  if (UNTHROTTLED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'))) return null;
  for (const [prefix, config] of Object.entries(RATE_LIMITS)) {
    if (path === prefix || path.startsWith(prefix + '/')) {
      return config;
    }
  }
  return null;
}

function matchInternalRateLimit(path: string): RateLimitConfig | null {
  const contributed = extensionRateLimit(path, true);
  if (contributed) return contributed;
  for (const [prefix, config] of Object.entries(INTERNAL_RATE_LIMITS)) {
    if (path === prefix || path.startsWith(prefix + '/')) {
      return config;
    }
  }
  return null;
}

/**
 * Rate limiting middleware.
 * Apply per-IP and per-user rate limits based on endpoint configuration.
 */
export async function rateLimitMiddleware(c: Context, next: Next) {
  const config = matchRateLimit(c.req.path);
  if (!config) return next();

  const ip = getRequestSourceIp(c);

  // Check if user is internal (for higher limits)
  const user = c.get('user') as { id?: string; role?: string } | undefined;
  const isInternal = user?.role === 'super' || user?.role === 'team';
  const effectiveConfig = isInternal ? (matchInternalRateLimit(c.req.path) ?? config) : config;

  // Per-IP and (if authenticated) per-user limits, counted together.
  const scope = c.req.path.split('/').slice(0, 4).join('/');
  const [ipResult, userResult] = await Promise.all([
    checkRateLimit(`ip:${ip}:${scope}`, effectiveConfig.windowMs, effectiveConfig.max),
    user?.id ? checkRateLimit(`user:${user.id}:${scope}`, effectiveConfig.windowMs, effectiveConfig.max) : null,
  ]);

  if (userResult && !userResult.allowed) {
    c.header('X-RateLimit-Limit', String(effectiveConfig.max));
    c.header('X-RateLimit-Remaining', '0');
    c.header('X-RateLimit-Reset', String(Math.ceil(userResult.resetAt / 1000)));
    return c.json({ error: 'Too many requests. Please try again later.' }, 429);
  }

  c.header('X-RateLimit-Limit', String(effectiveConfig.max));
  c.header('X-RateLimit-Remaining', String(Math.max(0, ipResult.remaining)));
  c.header('X-RateLimit-Reset', String(Math.ceil(ipResult.resetAt / 1000)));

  if (!ipResult.allowed) {
    return c.json({ error: 'Too many requests. Please try again later.' }, 429);
  }

  return next();
}

// ─── Security Headers ────────────────────────────────────

/**
 * Add standard security headers to all responses.
 */
export async function securityHeadersMiddleware(c: Context, next: Next) {
  await next();

  c.header('X-Content-Type-Options', 'nosniff');
  const pluginUi = c.get('extensionUi') === true;
  if (!pluginUi) c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header(
    'Content-Security-Policy',
    pluginUi
      ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self' tauri://localhost"
      : [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          "worker-src 'self' blob:",
          "style-src 'self' 'unsafe-inline'",
          "font-src 'self' data:",
          "img-src 'self' data: blob: https://unpkg.com https://*.myqcloud.com https://ui-avatars.com",
          "media-src 'self' https://*.myqcloud.com",
          "frame-src 'self' https://*.myqcloud.com",
          // COS: authed file endpoints (chat files, Drive) 302 to a presigned object
          // URL, and fetch()-based downloads follow that redirect from the page.
          "connect-src 'self' https://unpkg.com https://*.myqcloud.com",
        ].join('; '),
  );

  // Only add HSTS if we detect we're behind HTTPS
  if (c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https://')) {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

// ─── Request Log Redaction ──────────────────────────────

const SENSITIVE_QUERY_KEYS = new Set([
  'authorization',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'state',
  'password',
  'api_key',
  'apikey',
  'client_secret',
  'secret',
  'signature',
  'sig',
]);

function isSensitiveQueryKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll('-', '_');
  return (
    SENSITIVE_QUERY_KEYS.has(normalized) ||
    normalized.endsWith('_token') ||
    normalized.endsWith('_password') ||
    normalized.endsWith('_secret') ||
    normalized.endsWith('_api_key')
  );
}

/** Return a query string safe for logs while preserving non-secret diagnostics. */
export function redactQueryForLog(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  for (const key of new Set(params.keys())) {
    if (isSensitiveQueryKey(key)) params.set(key, '[REDACTED]');
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

// ─── Prompt Injection Detection ──────────────────────────

const INJECTION_PATTERNS: Array<{ pattern: RegExp; severity: 'high' | 'medium' }> = [
  // Direct instruction override attempts
  { pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/i, severity: 'high' },
  {
    pattern: /disregard\s+(your\s+)?(all\s+)?(previous|prior|above|system)\s*(instructions|prompts)/i,
    severity: 'high',
  },
  { pattern: /override\s+(all\s+)?(system|previous|safety)\s*(prompt|instructions|rules)/i, severity: 'high' },
  { pattern: /forget\s+(all\s+)?(previous|your)\s+(instructions|rules|context)/i, severity: 'high' },

  // System prompt extraction
  { pattern: /reveal\s+(your|the)\s+(system|initial)\s*(prompt|instructions|message)/i, severity: 'high' },
  { pattern: /output\s+(your|the)\s+(full\s+)?(system\s+)?(prompt|instructions|message)/i, severity: 'high' },
  { pattern: /print\s+(your|the)\s+system\s*(prompt|message|instructions)/i, severity: 'high' },
  { pattern: /what\s+(are|is)\s+your\s+(system|initial|original)\s*(prompt|instructions)/i, severity: 'medium' },
  { pattern: /show\s+me\s+your\s+(instructions|prompt|rules|config)/i, severity: 'medium' },

  // Chinese variants
  { pattern: /忽略(之前|以上|所有)(所有)?(的)?(指令|提示|规则|指示)/i, severity: 'high' },
  { pattern: /输出(你的)?(系统)?(提示|指令|prompt)/i, severity: 'high' },
  { pattern: /显示(你的)?(系统)?(提示|指令|初始消息|提示词)/i, severity: 'high' },
  { pattern: /你的(系统|初始)(提示|指令)是什么/i, severity: 'medium' },

  // Role-playing manipulation
  { pattern: /you\s+are\s+now\s+(a|an|my)\s+(?!greenhouse)/i, severity: 'medium' },
  { pattern: /pretend\s+(to\s+be|you\s*(?:are|'re))\s+(?!a\s+(?:plant|garden|hydroponic))/i, severity: 'medium' },
  { pattern: /act\s+as\s+(?!a\s+(?:plant|garden|hydroponic))/i, severity: 'medium' },

  // Tool manipulation
  { pattern: /call\s+(the\s+)?update_page\s+tool/i, severity: 'medium' },
  { pattern: /execute\s+(the\s+)?tool\s+(call|named)/i, severity: 'medium' },
];

export interface InjectionCheckResult {
  safe: boolean;
  detections: Array<{ pattern: string; severity: 'high' | 'medium' }>;
}

/**
 * Check user input for potential prompt injection attempts.
 * Returns safe=true if no patterns detected.
 */
export function checkPromptInjection(input: string): InjectionCheckResult {
  const detections: Array<{ pattern: string; severity: 'high' | 'medium' }> = [];

  for (const { pattern, severity } of INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      detections.push({ pattern: pattern.source.slice(0, 60), severity });
    }
  }

  return {
    safe: detections.length === 0,
    detections,
  };
}

// ─── Input Sanitization ──────────────────────────────────

/**
 * Sanitize user input for safe inclusion in prompts.
 * Defenses:
 * 1. Length truncation — prevents context window abuse
 * 2. Unicode normalization — blocks homoglyph attacks
 * 3. Role/system delimiter stripping — blocks role injection attempts
 * 4. XML/JSON tag neutralization — blocks structured injection
 */
export function sanitizeForPrompt(input: string): string {
  // 1. Limit length to prevent context window abuse
  const MAX_INPUT_LENGTH = 8000;
  let sanitized = input.slice(0, MAX_INPUT_LENGTH);

  // 2. Normalize unicode that could be used to hide injection
  sanitized = sanitized.normalize('NFC');

  // 3. Strip role injection delimiters — prevent user from injecting
  //    fake system/assistant messages into the prompt
  sanitized = sanitized
    .replace(/\n\s*(system|assistant|user)\s*:\s*/gi, '\n')
    .replace(/<\|?(system|assistant|user|im_start|im_end)\|?>/gi, '');

  // 4. Neutralize XML-style structured injection attempts
  //    (e.g. <tool_call>, <function>, <instructions>)
  sanitized = sanitized.replace(/<\/?(tool_call|function_call|function|instructions|tool_result)[^>]*>/gi, '');

  // 5. Strip invisible/zero-width characters that could hide injections
  sanitized = sanitized.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '');

  return sanitized;
}

// ─── File Upload Validation ──────────────────────────────

const MAGIC_BYTES: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/gif': [0x47, 0x49, 0x46, 0x38],
  'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF header; WEBP follows at offset 8
};

/**
 * Validate file content matches claimed MIME type using magic bytes.
 */
export function validateMagicBytes(buffer: Buffer, claimedType: string): boolean {
  const expected = MAGIC_BYTES[claimedType];
  if (!expected) return false;

  if (buffer.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (buffer[i] !== expected[i]) return false;
  }

  // Additional check for WebP: bytes 8-11 should be "WEBP"
  if (claimedType === 'image/webp' && buffer.length >= 12) {
    const webpSig = buffer.slice(8, 12).toString('ascii');
    if (webpSig !== 'WEBP') return false;
  }

  return true;
}
