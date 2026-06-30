/**
 * Security middleware — rate limiting, security headers, input validation.
 *
 * Provides defense-in-depth for public-facing deployment:
 * - IP-based rate limiting (in-memory, per-endpoint)
 * - Standard security response headers
 * - Profile access control enforcement
 */

import type { Context, Next } from 'hono';

// ─── Rate Limiter ────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

class InMemoryRateLimiter {
  private store = new Map<string, RateLimitEntry>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(private cleanupIntervalMs = 60_000) {
    this.cleanupInterval = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    this.cleanupInterval.unref();
  }

  /**
   * Check and increment rate limit.
   * @returns remaining requests, or -1 if exceeded
   */
  check(key: string, windowMs: number, maxRequests: number): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || entry.resetAt <= now) {
      this.store.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs };
    }

    entry.count++;
    if (entry.count > maxRequests) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt };
    }

    return { allowed: true, remaining: maxRequests - entry.count, resetAt: entry.resetAt };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.resetAt <= now) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}

const limiter = new InMemoryRateLimiter();

// ─── CORS ────────────────────────────────────────────────

// No origins are allowed by default — the operator declares the web app /
// API origins via the CORS_ALLOWED_ORIGINS env var (comma-separated).
const DEFAULT_CORS_ORIGINS: string[] = [];

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
 * Allow cross-origin API access only from the origins the operator declares in
 * CORS_ALLOWED_ORIGINS. Clients store bearer tokens in localStorage, so no
 * cookie credentials are required.
 */
export async function corsMiddleware(c: Context, next: Next) {
  const origin = c.req.header('Origin') || '';
  const allowed = origin && isAllowedCorsOrigin(origin);

  if (allowed) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Workspace-Id, X-Requested-With');
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
  '/api/auth': { windowMs: 5 * 60_000, max: 10 }, // 10 attempts per 5 min
  '/api/chat': { windowMs: 60_000, max: 15 }, // 15 messages per min (overridden for internal)
  '/api/email/accounts': { windowMs: 60_000, max: 30 }, // 30 account ops per min
  '/api/email/oauth': { windowMs: 5 * 60_000, max: 10 }, // 10 OAuth attempts per 5 min
  // Other admin endpoints intentionally unthrottled — admin-only usage
};

// Internal users get higher limits
const INTERNAL_RATE_LIMITS: Record<string, RateLimitConfig> = {
  '/api/chat': { windowMs: 60_000, max: 30 }, // 30 messages per min for internal users
};

function getClientIP(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
}

function matchRateLimit(path: string): RateLimitConfig | null {
  for (const [prefix, config] of Object.entries(RATE_LIMITS)) {
    if (path === prefix || path.startsWith(prefix + '/')) {
      return config;
    }
  }
  return null;
}

function matchInternalRateLimit(path: string): RateLimitConfig | null {
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
  // V1 endpoints have their own per-API-Key rate limiting
  if (c.req.path.startsWith('/api/v1/')) return next();

  // /api/auth/status is a harmless config check (no auth, no side effects)
  // — exempt from the /api/auth login-attempt rate limit bucket.
  if (c.req.path === '/api/auth/status') return next();

  const config = matchRateLimit(c.req.path);
  if (!config) return next();

  const ip = getClientIP(c);

  // Check if user is internal (for higher limits)
  const user = c.get('user') as { id?: string; role?: string } | undefined;
  const isInternal = user && user.role && user.role !== 'external';
  const effectiveConfig = isInternal ? (matchInternalRateLimit(c.req.path) ?? config) : config;

  // Per-IP rate limiting
  const ipKey = `ip:${ip}:${c.req.path.split('/').slice(0, 4).join('/')}`;
  const ipResult = limiter.check(ipKey, effectiveConfig.windowMs, effectiveConfig.max);

  // Per-user rate limiting (if authenticated)
  if (user?.id && user.id !== 'external') {
    const userKey = `user:${user.id}:${c.req.path.split('/').slice(0, 4).join('/')}`;
    const userResult = limiter.check(userKey, effectiveConfig.windowMs, effectiveConfig.max);
    if (!userResult.allowed) {
      c.header('X-RateLimit-Limit', String(effectiveConfig.max));
      c.header('X-RateLimit-Remaining', '0');
      c.header('X-RateLimit-Reset', String(Math.ceil(userResult.resetAt / 1000)));
      return c.json({ error: 'Too many requests. Please try again later.' }, 429);
    }
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
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "frame-src 'self'",
      "connect-src 'self'",
    ].join('; '),
  );

  // Only add HSTS if we detect we're behind HTTPS
  if (c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https://')) {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

// ─── Profile Access Control ──────────────────────────────

import { getPublicProfileIds, getAdminProfileIds, resolveProfile, onProfileCacheClear } from './profile.js';

/**
 * Profiles that can only be used through session mode (not stateless chat).
 * Derived from profile YAML `access.requires_session: true`.
 * Lazily cached — populated on first access after profiles are loaded.
 */
let _adminProfiles: Set<string> | null = null;
export function getAdminProfiles(): Set<string> {
  if (!_adminProfiles) _adminProfiles = getAdminProfileIds();
  return _adminProfiles;
}

/**
 * Profiles safe for public/anonymous access.
 * Derived from profile YAML `access.level: 'public'`.
 */
let _publicProfiles: Set<string> | null = null;
export function getPublicProfiles(): Set<string> {
  if (!_publicProfiles) _publicProfiles = getPublicProfileIds();
  return _publicProfiles;
}

// Register for cache invalidation when profiles are reloaded
onProfileCacheClear(() => {
  _adminProfiles = null;
  _publicProfiles = null;
});

/**
 * Validate that a profile can be used in the given context.
 * Uses the profile's declared access metadata.
 */
export function validateProfileAccess(profileId: string, hasSessionId: boolean): { allowed: boolean; reason?: string } {
  // Custom profiles don't need the YAML-based validation
  if (profileId.startsWith('custom:')) {
    return { allowed: true };
  }
  try {
    const profile = resolveProfile(profileId);
    if (profile.access.requires_session && !hasSessionId) {
      return {
        allowed: false,
        reason: `Profile "${profileId}" requires an existing session and cannot be used in stateless mode`,
      };
    }
  } catch {
    // Profile not found — allow (will fail later during profile resolution)
  }
  return { allowed: true };
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
  { pattern: /you\s+are\s+now\s+(a|an|my)\s+/i, severity: 'medium' },
  { pattern: /pretend\s+(to\s+be|you\s*(?:are|'re))\s+/i, severity: 'medium' },
  { pattern: /act\s+as\s+(a|an)\s+/i, severity: 'medium' },

  // Tool manipulation
  { pattern: /call\s+(the\s+)?\w+\s+tool\b/i, severity: 'medium' },
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

// ─── Export for testing ──────────────────────────────────

export { InMemoryRateLimiter };
