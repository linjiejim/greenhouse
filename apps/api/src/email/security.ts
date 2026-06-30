/**
 * Email security utilities — sanitization, validation, SSRF prevention, draft tokens.
 *
 * Defense-in-depth for the email module:
 * 1. XSS prevention — HTML escaping for OAuth callback pages
 * 2. Prompt injection defense — sanitize email content before it enters LLM context
 * 3. SSRF prevention — block internal/reserved hosts for IMAP/SMTP
 * 4. Email address validation — reject malformed addresses
 * 5. OData injection prevention — escape Outlook search queries
 * 6. Draft token system — server-side send confirmation with single-use tokens
 */

import { randomBytes } from 'node:crypto';
import { logger } from '@greenhouse/utils/logger';

// ─── HTML Escaping (XSS Prevention) ──────────────────────

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

/** Escape HTML special characters to prevent XSS in rendered HTML. */
export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

// ─── Email Content Sanitization for LLM ──────────────────

/** Max characters of email body to return to LLM. */
const MAX_BODY_LENGTH = 4000;

/** Max characters of email subject/snippet to return to LLM. */
const MAX_SUBJECT_LENGTH = 500;

/**
 * Strip HTML tags from email body, returning plain text.
 * Removes style/script blocks first, then all remaining tags.
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sanitize a single text field for safe LLM consumption.
 * Removes potential prompt injection delimiters and truncates.
 */
function sanitizeTextField(text: string, maxLength: number): string {
  let s = text.slice(0, maxLength);

  // Normalize unicode to prevent homoglyph attacks
  s = s.normalize('NFC');

  // Strip role injection delimiters — prevent fake system/assistant messages
  // Match both after newline AND at start of string
  s = s
    .replace(/(^|\n)\s*(system|assistant|user)\s*:\s*/gi, '$1')
    .replace(/<\|?(system|assistant|user|im_start|im_end)\|?>/gi, '');

  // Neutralize XML-style structured injection attempts
  s = s.replace(/<\/?(tool_call|function_call|function|instructions|tool_result)[^>]*>/gi, '');

  // Strip invisible/zero-width characters that could hide injections
  s = s.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '');

  return s;
}

/**
 * Sanitize email message detail before returning to LLM context.
 *
 * Key defenses:
 * - Strips HTML → plain text for body (removes scripts, styles, tags)
 * - Truncates long content to prevent context window abuse
 * - Removes prompt injection patterns from all text fields
 * - Wraps content in boundary markers so LLM knows it's external data
 */
export function sanitizeEmailForLLM(message: any): any {
  const sanitized = { ...message };

  // Sanitize subject
  if (sanitized.subject) {
    sanitized.subject = sanitizeTextField(sanitized.subject, MAX_SUBJECT_LENGTH);
  }

  // Sanitize snippet
  if (sanitized.snippet) {
    sanitized.snippet = sanitizeTextField(sanitized.snippet, 500);
  }

  // For detailed message: prefer plain text, strip HTML body
  if (sanitized.body_html) {
    const plainFromHtml = stripHtmlTags(sanitized.body_html);
    // Use HTML-derived text if no plain text or plain text is significantly shorter
    if (!sanitized.body_text || sanitized.body_text.length < plainFromHtml.length * 0.5) {
      sanitized.body_text = plainFromHtml;
    }
    // Remove HTML body from LLM context — only return plain text
    delete sanitized.body_html;
  }

  if (sanitized.body_text) {
    sanitized.body_text = sanitizeTextField(sanitized.body_text, MAX_BODY_LENGTH);
  }

  // Sanitize from/to/cc display names (could contain injection)
  if (sanitized.from?.name) {
    sanitized.from = { ...sanitized.from, name: sanitizeTextField(sanitized.from.name, 200) };
  }
  if (Array.isArray(sanitized.to)) {
    sanitized.to = sanitized.to.map((addr: any) =>
      addr.name ? { ...addr, name: sanitizeTextField(addr.name, 200) } : addr,
    );
  }
  if (Array.isArray(sanitized.cc)) {
    sanitized.cc = sanitized.cc.map((addr: any) =>
      addr.name ? { ...addr, name: sanitizeTextField(addr.name, 200) } : addr,
    );
  }

  return sanitized;
}

/**
 * Sanitize email list results before returning to LLM context.
 */
export function sanitizeEmailListForLLM(result: any): any {
  if (!result?.messages) return result;
  return {
    ...result,
    messages: result.messages.map((m: any) => sanitizeEmailForLLM(m)),
  };
}

// ─── Email Address Validation ────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate email address format. Returns true if valid. */
export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email) && email.length <= 254;
}

/**
 * Validate a list of email address objects.
 * Returns an error string if invalid, null if all valid.
 */
export function validateEmailAddresses(
  addresses: Array<{ name?: string; address: string }>,
  fieldName: string,
): string | null {
  for (const addr of addresses) {
    if (!addr.address || !isValidEmail(addr.address)) {
      return `Invalid email address in ${fieldName}: "${addr.address}"`;
    }
  }
  return null;
}

// ─── SSRF Prevention ────────────────────────────────────

const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/, // AWS/cloud metadata
  /^0\.0\.0\.0$/,
  /^::1?$/,
  /^fd[0-9a-f]{2}:/i, // IPv6 ULA
  /^fe80:/i, // IPv6 link-local
  /\.local$/i,
  /\.internal$/i,
  /\.svc\.cluster\.local$/i, // Kubernetes services
  /^metadata\.google\.internal$/i, // GCP metadata
];

/**
 * Check if a host is safe for SMTP/IMAP connection (not internal/reserved).
 * Returns true if the host is allowed, false if it's blocked.
 */
export function isAllowedMailHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h || h.length > 253) return false;

  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (pattern.test(h)) return false;
  }

  // Must contain a dot (valid domain or IP)
  if (!h.includes('.') && !h.includes(':')) return false;

  return true;
}

// ─── OData Query Escaping ────────────────────────────────

/**
 * Escape a string for use in Microsoft Graph OData $search parameter.
 * Removes double quotes to prevent query breakout attacks.
 */
export function escapeODataSearch(query: string): string {
  return query.replace(/"/g, '').slice(0, 500);
}

// ─── Draft Token Store ───────────────────────────────────

export interface DraftEntry {
  token: string;
  userId: string;
  accountId: number;
  to: Array<{ name?: string; address: string }>;
  cc?: Array<{ name?: string; address: string }>;
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string[];
  seq: number;
  createdAt: number;
  expiresAt: number;
}

const draftStore = new Map<string, DraftEntry>();

/** Monotonic sequence counter for draft ordering. */
let draftSeq = 0;

/** Draft validity window — 10 minutes. */
const DRAFT_TTL_MS = 10 * 60 * 1000;

/** Max pending drafts per user (prevent abuse). */
const MAX_DRAFTS_PER_USER = 20;

/**
 * Character set for short draft tokens: uppercase + digits, excluding ambiguous chars.
 * 30 chars ^ 6 = ~729 million combinations — plenty for a 10-minute window.
 */
const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Generate a short, LLM-friendly draft token (6 uppercase alphanumeric chars). */
function generateShortToken(): string {
  const bytes = randomBytes(6);
  let token = '';
  for (let i = 0; i < 6; i++) {
    token += TOKEN_CHARS[bytes[i] % TOKEN_CHARS.length];
  }
  return token;
}

/** Cleanup expired drafts. */
function cleanupDrafts(): void {
  const now = Date.now();
  for (const [key, entry] of draftStore) {
    if (entry.expiresAt < now) draftStore.delete(key);
  }
}

/**
 * Create a server-side draft entry and return a single-use token.
 *
 * When the agent calls `draft_email`, the email content is stored here.
 * When `send_email` is called later, it MUST provide this token and the
 * actual sent content is taken from the stored draft — not from the LLM's input.
 * This prevents a prompt-injected LLM from changing recipients at send time.
 */
export function createDraftToken(
  userId: string,
  accountId: number,
  email: {
    to: Array<{ name?: string; address: string }>;
    cc?: Array<{ name?: string; address: string }>;
    subject: string;
    bodyText?: string;
    bodyHtml?: string;
    inReplyTo?: string;
    references?: string[];
  },
): string {
  cleanupDrafts();

  // Limit per-user pending drafts
  let userDraftCount = 0;
  for (const entry of draftStore.values()) {
    if (entry.userId === userId) userDraftCount++;
  }
  if (userDraftCount >= MAX_DRAFTS_PER_USER) {
    // Evict oldest draft for this user
    let oldestKey: string | null = null;
    let oldestSeq = Infinity;
    for (const [key, entry] of draftStore) {
      if (entry.userId === userId && entry.seq < oldestSeq) {
        oldestKey = key;
        oldestSeq = entry.seq;
      }
    }
    if (oldestKey) draftStore.delete(oldestKey);
  }

  const token = generateShortToken();
  draftStore.set(token, {
    token,
    userId,
    accountId,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    bodyText: email.bodyText,
    bodyHtml: email.bodyHtml,
    inReplyTo: email.inReplyTo,
    references: email.references,
    seq: ++draftSeq,
    createdAt: Date.now(),
    expiresAt: Date.now() + DRAFT_TTL_MS,
  });

  logger.info(`[Email Security] Draft token created for user ${userId}, account ${accountId}: ${token.slice(0, 8)}...`);
  return token;
}

/**
 * Validate and consume a draft token (single-use).
 *
 * Returns the stored draft entry if valid, null otherwise.
 * The token is deleted after consumption — it cannot be reused.
 *
 * Token matching is case-insensitive to tolerate LLM casing variations.
 */
export function consumeDraftToken(token: string, userId: string): DraftEntry | null {
  cleanupDrafts();

  // Normalize: uppercase, strip spaces/dashes the LLM might have inserted
  const normalized = token.replace(/[\s-]/g, '').toUpperCase();

  const entry = draftStore.get(normalized);
  if (!entry) {
    logger.warn(`[Email Security] Draft token not found or already used: ${normalized}`);
    return null;
  }
  if (entry.expiresAt < Date.now()) {
    draftStore.delete(normalized);
    logger.warn(`[Email Security] Draft token expired: ${normalized}`);
    return null;
  }
  if (entry.userId !== userId) {
    logger.warn(`[Email Security] Draft token user mismatch: expected ${entry.userId}, got ${userId}`);
    return null;
  }

  // Consume: single-use — delete after validation
  draftStore.delete(normalized);
  return entry;
}

/**
 * Find the most recent pending draft for a user.
 *
 * Fallback for when the LLM fabricates or misremembers a token.
 * Returns the draft without consuming it — the caller must still call
 * consumeDraftToken() with the real token to actually send.
 */
export function findLatestDraft(userId: string, accountId?: number): DraftEntry | null {
  cleanupDrafts();
  let latest: DraftEntry | null = null;
  for (const entry of draftStore.values()) {
    if (entry.userId !== userId) continue;
    if (accountId !== undefined && entry.accountId !== accountId) continue;
    if (!latest || entry.seq > latest.seq) {
      latest = entry;
    }
  }
  return latest;
}

/** Get pending draft count (for testing/monitoring). */
export function getPendingDraftCount(): number {
  cleanupDrafts();
  return draftStore.size;
}

/** Clear all drafts (for testing). */
export function clearAllDrafts(): void {
  draftStore.clear();
}
