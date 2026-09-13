/**
 * Email service — mailbox resolution, the shared system mailbox, and the one
 * guarded send path.
 *
 * Two kinds of mailbox exist and they are deliberately different things:
 *
 *  • PERSONAL — a row in email_accounts owned by one user. Credentials are
 *    theirs, encrypted at rest, and they can write to anyone.
 *  • SHARED   — greenhouse@example.com, configured entirely through env. It is
 *    operations-owned infrastructure, not a user's belonging, so it is NOT a
 *    row with a synthetic owner (that shape is what produced the
 *    knowledge_base.user_id incident). Chat access is super-only; automation
 *    delivery rides it for everyone but never through a model.
 *
 * sendMail() is the ONLY place a message leaves the building. Ownership,
 * recipient policy, rate limits and the audit row all live here so the tool
 * layer, the routes and the scheduler cannot each grow their own version.
 */

import type { DatabaseProvider, EmailAccountRow } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { decryptToken, isEncryptionConfigured } from '../auth/crypto.js';
import { ImapSmtpClient, MailboxError } from './imap-smtp-client.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_PERSONAL_SENDS_PER_DAY,
  MAX_RECIPIENTS_PER_MESSAGE,
  MAX_SHARED_SENDS_PER_DAY,
} from './limits.js';
import { checkSharedRecipients, validateEmailAddresses } from './security.js';
import type { EmailAddress, MailboxCredentials, SendEmailOptions } from './types.js';

export { MailboxError };

/**
 * Which mailbox a caller is asking for: 'shared', a personal account id, or the
 * address itself.
 *
 * The address form exists because `list_accounts` reports both `mailbox` and
 * `email_address`, and the model reasonably passes either — passing the address
 * used to fail the numeric parse and answer "mailbox is required", i.e. the one
 * thing that was not true about that call. `resolveMailbox` normalizes it back
 * to an account id.
 */
export type MailboxRef = 'shared' | number | { address: string };

export function parseMailboxRef(value: string | number | undefined): MailboxRef | null {
  if (value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (trimmed === 'shared') return 'shared';
    if (trimmed.includes('@')) return { address: trimmed.toLowerCase() };
    const id = Number.parseInt(trimmed, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  }
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Say which of the two failures happened, rather than "mailbox is required" for
 * both. A model that did pass a mailbox cannot act on being told it did not.
 */
export function mailboxRefError(given: string | number | undefined): string {
  if (given === undefined || String(given).trim() === '') {
    return 'mailbox is required — call list_accounts first and pass one of its "mailbox" values.';
  }
  return `"${given}" is not a mailbox id or address — call list_accounts and use one of its "mailbox" values.`;
}

// ─── Shared system mailbox ───────────────────────────────

/**
 * Read the shared mailbox out of env. Returns null when unconfigured — callers
 * turn that into an explicit error rather than a silent no-op, because a
 * mailbox that quietly does not exist is exactly the false capability the
 * repo's rules forbid.
 */
export function getSharedMailboxCredentials(): MailboxCredentials | null {
  const address = process.env.SHARED_MAILBOX_ADDRESS?.trim();
  const password = process.env.SHARED_MAILBOX_PASSWORD;
  const imapHost = process.env.SHARED_MAILBOX_IMAP_HOST?.trim();
  const smtpHost = process.env.SHARED_MAILBOX_SMTP_HOST?.trim();
  if (!address || !password || !imapHost || !smtpHost) return null;

  return {
    email_address: address,
    display_name: process.env.SHARED_MAILBOX_DISPLAY_NAME?.trim() || 'Greenhouse',
    imap_host: imapHost,
    imap_port: Number.parseInt(process.env.SHARED_MAILBOX_IMAP_PORT ?? '993', 10),
    smtp_host: smtpHost,
    smtp_port: Number.parseInt(process.env.SHARED_MAILBOX_SMTP_PORT ?? '465', 10),
    use_tls: process.env.SHARED_MAILBOX_USE_TLS !== '0',
    use_proxy: process.env.SHARED_MAILBOX_USE_PROXY === '1',
    username: process.env.SHARED_MAILBOX_USERNAME?.trim() || address,
    password,
  };
}

export function isSharedMailboxConfigured(): boolean {
  return getSharedMailboxCredentials() !== null;
}

// ─── Mailbox resolution ──────────────────────────────────

export interface ResolvedMailbox {
  ref: MailboxRef;
  scope: 'personal' | 'shared';
  address: string;
  displayName: string | null;
  client: ImapSmtpClient;
  /** Only set for personal mailboxes. */
  accountId?: number;
}

export function toCredentials(row: EmailAccountRow): MailboxCredentials {
  return {
    email_address: row.email_address,
    display_name: row.display_name,
    imap_host: row.imap_host,
    imap_port: row.imap_port,
    smtp_host: row.smtp_host,
    smtp_port: row.smtp_port,
    use_tls: row.use_tls,
    use_proxy: row.use_proxy,
    username: row.username,
    password: decryptToken(row.password_encrypted),
  };
}

export interface MailboxActor {
  userId: string;
  userRole: string;
}

/**
 * Resolve a mailbox reference for an actor, or explain why not.
 *
 * The shared mailbox is super-only on this path. Automation delivery does not
 * come through here — it has no actor and no model, so it calls
 * sendFromSharedMailbox() directly.
 */
export async function resolveMailbox(
  db: DatabaseProvider,
  actor: MailboxActor,
  ref: MailboxRef,
): Promise<{ ok: true; mailbox: ResolvedMailbox } | { ok: false; error: string }> {
  if (typeof ref === 'object') {
    const shared = getSharedMailboxCredentials();
    if (shared && shared.email_address.toLowerCase() === ref.address) {
      return resolveMailbox(db, actor, 'shared');
    }
    const rows = await db.email.listAccountsByUser(actor.userId);
    const row = rows.find((r) => r.email_address.toLowerCase() === ref.address);
    if (!row) {
      return {
        ok: false,
        error: `No mailbox "${ref.address}" is bound to your account. Call list_accounts and use one of the "mailbox" values it returns.`,
      };
    }
    return resolveMailbox(db, actor, row.id);
  }

  if (ref === 'shared') {
    if (actor.userRole !== 'super') {
      return { ok: false, error: 'The shared Greenhouse mailbox is restricted to administrators.' };
    }
    const creds = getSharedMailboxCredentials();
    if (!creds) {
      return {
        ok: false,
        error:
          'The shared Greenhouse mailbox is not configured on this server (SHARED_MAILBOX_* environment variables are missing).',
      };
    }
    return {
      ok: true,
      mailbox: {
        ref,
        scope: 'shared',
        address: creds.email_address,
        displayName: creds.display_name ?? null,
        client: new ImapSmtpClient(creds),
      },
    };
  }

  if (!isEncryptionConfigured()) {
    return { ok: false, error: 'Mailbox credentials cannot be read: PROVIDER_TOKEN_ENCRYPTION_KEY is not configured.' };
  }

  const row = await db.email.getAccount(ref);
  // Not-found and not-yours are the same answer: a probe must not learn that
  // account 7 exists but belongs to someone else.
  if (!row || row.user_id !== actor.userId) {
    return { ok: false, error: `Email account ${ref} not found.` };
  }
  if (row.status === 'disabled') {
    return { ok: false, error: `Email account ${row.email_address} is disabled.` };
  }

  return {
    ok: true,
    mailbox: {
      ref,
      scope: 'personal',
      address: row.email_address,
      displayName: row.display_name,
      client: new ImapSmtpClient(toCredentials(row)),
      accountId: row.id,
    },
  };
}

// ─── Send path ───────────────────────────────────────────

export interface SendContext {
  userId: string;
  origin: 'chat' | 'automation' | 'account-security';
  sessionId?: string | null;
  taskId?: number | null;
}

function twentyFourHoursAgoIso(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function allRecipients(opts: SendEmailOptions): EmailAddress[] {
  return [...opts.to, ...(opts.cc ?? []), ...(opts.bcc ?? [])];
}

/**
 * Everything about a message that can be judged before it is composed:
 * addresses well-formed, recipient count, and the shared-mailbox allowlist.
 *
 * ONE implementation, called from two places on purpose — `draft` runs it so
 * the user is never shown a confirmation card for a message that will be
 * refused after they press Send, and `sendMail` runs it again because the draft
 * check is a courtesy while this one is the boundary. Splitting them into two
 * policies would mean the card could promise something the send path forbids.
 */
export async function checkRecipientPolicy(
  db: DatabaseProvider,
  mailbox: Pick<ResolvedMailbox, 'scope'>,
  opts: Pick<SendEmailOptions, 'to' | 'cc' | 'bcc'>,
  userId: string,
): Promise<string | null> {
  const recipients = allRecipients(opts as SendEmailOptions);
  if (recipients.length === 0) return 'At least one recipient is required.';

  const invalid =
    validateEmailAddresses(opts.to, 'to') ??
    validateEmailAddresses(opts.cc ?? [], 'cc') ??
    validateEmailAddresses(opts.bcc ?? [], 'bcc');
  if (invalid) return invalid;

  if (recipients.length > MAX_RECIPIENTS_PER_MESSAGE) {
    return `Too many recipients (${recipients.length}); the limit is ${MAX_RECIPIENTS_PER_MESSAGE} per message.`;
  }

  if (mailbox.scope === 'shared') {
    const senderOwnAddress = await resolveActorAddress(db, userId);
    return checkSharedRecipients(recipients, senderOwnAddress);
  }

  return null;
}

/**
 * Validate and send. Order is fixed: shape → recipient policy → rate limits →
 * attachment budget → send → audit. Everything that can reject does so before
 * a single byte leaves.
 */
export async function sendMail(
  db: DatabaseProvider,
  mailbox: ResolvedMailbox,
  opts: SendEmailOptions,
  ctx: SendContext,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const recipients = allRecipients(opts);

  const violation = await checkRecipientPolicy(db, mailbox, opts, ctx.userId);
  if (violation) return { ok: false, error: violation };

  const since = twentyFourHoursAgoIso();
  if (mailbox.scope === 'shared') {
    const used = await db.email.countRecentSendsByScope('shared', since);
    if (used >= MAX_SHARED_SENDS_PER_DAY) {
      return {
        ok: false,
        error: `The shared mailbox has reached its daily send limit (${MAX_SHARED_SENDS_PER_DAY}/day). Try again tomorrow.`,
      };
    }
  } else {
    const used = await db.email.countRecentSendsByUser(ctx.userId, since);
    if (used >= MAX_PERSONAL_SENDS_PER_DAY) {
      return {
        ok: false,
        error: `You have reached your daily send limit (${MAX_PERSONAL_SENDS_PER_DAY}/day). Try again tomorrow.`,
      };
    }
  }

  const attachmentBytes = (opts.attachments ?? []).reduce((sum, a) => sum + a.content.byteLength, 0);
  if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `Attachments total ${(attachmentBytes / 1024 / 1024).toFixed(1)}MB; the limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB.`,
    };
  }

  const audit = {
    user_id: ctx.userId,
    account_scope: mailbox.scope,
    account_id: mailbox.accountId ?? null,
    from_address: mailbox.address,
    subject: opts.subject,
    recipients: recipients.map((r) => r.address),
    attachment_count: opts.attachments?.length ?? 0,
    origin: ctx.origin,
    session_id: ctx.sessionId ?? null,
    task_id: ctx.taskId ?? null,
  };

  try {
    const result = await mailbox.client.sendEmail(opts);
    await db.email.logSend({ ...audit, status: 'sent' });
    logger.info(`[Email] Sent from ${mailbox.address} to ${audit.recipients.join(', ')} (${ctx.origin})`);
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    const error = toErrorMessage(err);
    await db.email.logSend({ ...audit, status: 'failed', error_message: error });
    logger.warn(`[Email] Send failed from ${mailbox.address}: ${error}`);
    return { ok: false, error };
  }
}

/** The actor's own account address — the anchor of the shared-mailbox allowlist. */
async function resolveActorAddress(db: DatabaseProvider, userId: string): Promise<string> {
  const user = await db.users.getById(userId);
  return user?.email ?? '';
}

/**
 * Automation delivery: send from the shared mailbox with no actor and no
 * recipient choice. The caller has already decided the recipient is the task
 * owner, which is why this bypasses resolveMailbox's super-only gate — there is
 * no model in this path to aim it anywhere.
 */
export async function sendFromSharedMailbox(
  db: DatabaseProvider,
  to: EmailAddress,
  message: { subject: string; body_text: string; body_html?: string },
  ctx: SendContext,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const creds = getSharedMailboxCredentials();
  if (!creds) return { ok: false, error: 'Shared mailbox is not configured (SHARED_MAILBOX_* env missing).' };

  const mailbox: ResolvedMailbox = {
    ref: 'shared',
    scope: 'shared',
    address: creds.email_address,
    displayName: creds.display_name ?? null,
    client: new ImapSmtpClient(creds),
  };

  const since = twentyFourHoursAgoIso();
  const used = await db.email.countRecentSendsByScope('shared', since);
  if (used >= MAX_SHARED_SENDS_PER_DAY) {
    return { ok: false, error: `Shared mailbox daily send limit reached (${MAX_SHARED_SENDS_PER_DAY}/day).` };
  }
  if (!to.address || !to.address.includes('@')) {
    return { ok: false, error: `Recipient has no usable email address.` };
  }

  const audit = {
    user_id: ctx.userId,
    account_scope: 'shared' as const,
    account_id: null,
    from_address: mailbox.address,
    subject: message.subject,
    recipients: [to.address],
    attachment_count: 0,
    origin: ctx.origin,
    session_id: ctx.sessionId ?? null,
    task_id: ctx.taskId ?? null,
  };

  try {
    const result = await mailbox.client.sendEmail({
      to: [to],
      subject: message.subject,
      body_text: message.body_text,
      body_html: message.body_html,
    });
    await db.email.logSend({ ...audit, status: 'sent' });
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    const error = toErrorMessage(err);
    await db.email.logSend({ ...audit, status: 'failed', error_message: error });
    return { ok: false, error };
  }
}
