/**
 * Email security — LLM-facing sanitization, address validation, draft tokens.
 *
 * Recovered from the module deleted in 61efc4ab (0.18.0) with three changes,
 * each of which closed a real hole (see docs/specs/20260805-email-revival.md D3):
 *
 *  1. `findLatestDraft` is GONE. It let send_email fall back to "the user's most
 *     recent pending draft" when the token was wrong — so a prompt-injected
 *     model could draft a malicious message, pass any made-up token, and send
 *     it. An invalid token is now simply a refusal.
 *  2. The regex host blocklist is GONE. Reachability is decided at connect time
 *     against the resolved IP (imap-smtp-client.ts), which a DNS answer cannot
 *     dodge.
 *  3. escapeHtml / escapeODataSearch are GONE with their consumers (OAuth
 *     callback pages, Microsoft Graph).
 *
 * Sanitization is the load-bearing part: email bodies are attacker-authored
 * text that lands in the model's context. Everything read back from a mailbox
 * goes through sanitizeEmail* before it is returned.
 */

import { randomBytes } from 'node:crypto';
import { logger } from '@greenhouse/utils/logger';
import { DRAFT_TTL_MS, MAX_DRAFTS_PER_USER } from './limits.js';
import type { EmailAddress, EmailDetail, EmailSummary } from './types.js';

// ─── Content sanitization for LLM context ────────────────

/** Max characters of body text handed to the model. */
const MAX_BODY_LENGTH = 4000;

/** Max characters of subject handed to the model. */
const MAX_SUBJECT_LENGTH = 500;

/** Max characters of a snippet or display name. */
const MAX_SNIPPET_LENGTH = 500;
const MAX_NAME_LENGTH = 200;

/** Strip HTML to plain text — style/script blocks first, then all tags. */
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
 * Neutralize one text field: truncate, normalize, and remove the markers a
 * sender could use to impersonate the conversation's own structure.
 */
function sanitizeTextField(text: string, maxLength: number): string {
  let s = text.slice(0, maxLength);

  // ORDER MATTERS, and the deleted module had it wrong: invisibles are removed
  // FIRST. They exist to break up the very patterns matched below — "sys<ZWSP>tem:"
  // sails past the role regex, and stripping the ZWSP afterwards hands the model
  // a clean "system:" prefix. Normalize next, so homoglyphs cannot do the same.
  s = s.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '');
  s = s.normalize('NFC');

  // Fake turn boundaries — "system:", "<|im_start|>", etc.
  s = s
    .replace(/(^|\n)\s*(system|assistant|user)\s*:\s*/gi, '$1')
    .replace(/<\|?(system|assistant|user|im_start|im_end)\|?>/gi, '');

  // XML-ish structured injection.
  s = s.replace(/<\/?(tool_call|function_call|function|instructions|tool_result)[^>]*>/gi, '');

  return s;
}

function sanitizeAddress(addr: EmailAddress): EmailAddress {
  return addr.name ? { ...addr, name: sanitizeTextField(addr.name, MAX_NAME_LENGTH) } : addr;
}

/**
 * Sanitize a message before it enters LLM context.
 *
 * body_html is dropped entirely — its text is folded into body_text when that
 * is missing or clearly truncated, and the markup itself has no value to the
 * model while carrying every trick in the book.
 */
export function sanitizeEmailForLLM<T extends EmailSummary | EmailDetail>(message: T): T {
  const sanitized: T = { ...message };

  sanitized.subject = sanitizeTextField(sanitized.subject ?? '', MAX_SUBJECT_LENGTH);
  if (sanitized.snippet) sanitized.snippet = sanitizeTextField(sanitized.snippet, MAX_SNIPPET_LENGTH);
  if (sanitized.from) sanitized.from = sanitizeAddress(sanitized.from);
  if (Array.isArray(sanitized.to)) sanitized.to = sanitized.to.map(sanitizeAddress);

  const detail = sanitized as EmailDetail;
  if (Array.isArray(detail.cc)) detail.cc = detail.cc.map(sanitizeAddress);

  if (detail.body_html) {
    const plainFromHtml = stripHtmlTags(detail.body_html);
    if (!detail.body_text || detail.body_text.length < plainFromHtml.length * 0.5) {
      detail.body_text = plainFromHtml;
    }
    delete detail.body_html;
  }
  if (detail.body_text) {
    detail.body_text = sanitizeTextField(detail.body_text, MAX_BODY_LENGTH);
  }

  return sanitized;
}

export function sanitizeEmailListForLLM<T extends EmailSummary>(messages: T[]): T[] {
  return messages.map((m) => sanitizeEmailForLLM(m));
}

// ─── Address validation ──────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email) && email.length <= 254;
}

/** Returns an error string naming the offending address, or null when all are valid. */
export function validateEmailAddresses(addresses: EmailAddress[], fieldName: string): string | null {
  for (const addr of addresses) {
    if (!addr.address || !isValidEmail(addr.address)) {
      return `Invalid email address in ${fieldName}: "${addr.address}"`;
    }
  }
  return null;
}

/**
 * Recipient allowlist for the SHARED mailbox: the sender's own account address,
 * or anyone inside the company domain.
 *
 * Personal accounts are deliberately not filtered — a user sending as
 * themselves is doing what email is for. The shared mailbox is different: it
 * speaks for the company, and anything the agent read (customer data, internal
 * analysis) could otherwise be forwarded anywhere by one injected instruction.
 */
/**
 * Domain the shared mailbox may send to besides the sender's own address —
 * the company's own domain. Derived from SHARED_MAILBOX_ADDRESS (the part
 * after `@`) unless SHARED_MAILBOX_ALLOWED_DOMAIN overrides it; when neither
 * is configured the shared mailbox can only reply to itself (fail closed).
 */
export function sharedMailboxAllowedDomain(): string {
  const explicit = process.env.SHARED_MAILBOX_ALLOWED_DOMAIN?.trim().toLowerCase();
  if (explicit) return explicit;
  const address = process.env.SHARED_MAILBOX_ADDRESS?.trim().toLowerCase() ?? '';
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1) : '';
}

export function checkSharedRecipients(recipients: EmailAddress[], senderAccountEmail: string): string | null {
  const own = senderAccountEmail.trim().toLowerCase();
  const domain = sharedMailboxAllowedDomain();
  const violations = recipients
    .map((r) => r.address.trim().toLowerCase())
    .filter((address) => address !== own && !(domain && address.endsWith(`@${domain}`)));

  if (violations.length === 0) return null;
  const allowed = domain ? ` or @${domain} addresses` : '';
  return `The shared mailbox can only send to your own address (${senderAccountEmail})${allowed}. Rejected: ${violations.join(', ')}. Use your own bound mailbox to reach outside recipients.`;
}

// ─── Draft tokens ────────────────────────────────────────

export interface DraftEntry {
  token: string;
  userId: string;
  /** Which mailbox it will be sent from — 'shared' or a personal account id. */
  accountRef: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string[];
  /** Attachment ids resolved at send time, not bytes held in memory. */
  attachmentIds?: string[];
  seq: number;
  createdAt: number;
  expiresAt: number;
}

const draftStore = new Map<string, DraftEntry>();
let draftSeq = 0;

/** Uppercase + digits minus the ambiguous glyphs; 32^6 ≈ 1e9 per 10-minute window. */
const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateShortToken(): string {
  const bytes = randomBytes(6);
  let token = '';
  for (let i = 0; i < 6; i++) {
    token += TOKEN_CHARS[bytes[i]! % TOKEN_CHARS.length];
  }
  return token;
}

function cleanupDrafts(): void {
  const now = Date.now();
  for (const [key, entry] of draftStore) {
    if (entry.expiresAt < now) draftStore.delete(key);
  }
}

/**
 * Store a draft server-side and return its single-use token.
 *
 * This is why send_email is safe to expose: the bytes that actually go out are
 * read back from here, not from the send call's arguments. An injected model
 * cannot swap the recipient between the confirmation the user read and the
 * message that leaves.
 */
export function createDraftToken(
  userId: string,
  accountRef: string,
  email: Omit<DraftEntry, 'token' | 'userId' | 'accountRef' | 'seq' | 'createdAt' | 'expiresAt'>,
): string {
  cleanupDrafts();

  let userDraftCount = 0;
  for (const entry of draftStore.values()) {
    if (entry.userId === userId) userDraftCount++;
  }
  if (userDraftCount >= MAX_DRAFTS_PER_USER) {
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
  const now = Date.now();
  draftStore.set(token, {
    ...email,
    token,
    userId,
    accountRef,
    seq: ++draftSeq,
    createdAt: now,
    expiresAt: now + DRAFT_TTL_MS,
  });

  logger.info(`[Email] Draft ${token} created for user ${userId} (${accountRef})`);
  return token;
}

/**
 * Validate and consume a token. Single use: a second send with the same token
 * finds nothing.
 *
 * Matching tolerates the spaces/dashes/casing a model might introduce, but
 * there is NO fallback to "the most recent draft" — a wrong token means the
 * model must draft again and the user must confirm again.
 */
export function consumeDraftToken(token: string, userId: string): DraftEntry | null {
  cleanupDrafts();

  const normalized = token.replace(/[\s-]/g, '').toUpperCase();
  const entry = draftStore.get(normalized);
  if (!entry) {
    logger.warn(`[Email] Draft token not found or already used: ${normalized}`);
    return null;
  }
  if (entry.expiresAt < Date.now()) {
    draftStore.delete(normalized);
    logger.warn(`[Email] Draft token expired: ${normalized}`);
    return null;
  }
  if (entry.userId !== userId) {
    logger.warn(`[Email] Draft token user mismatch on ${normalized}`);
    return null;
  }

  draftStore.delete(normalized);
  return entry;
}

/** Pending draft count — monitoring and tests. */
export function getPendingDraftCount(): number {
  cleanupDrafts();
  return draftStore.size;
}

/** Tests only. */
export function clearAllDrafts(): void {
  draftStore.clear();
}
