/**
 * Account setup/reset delivery, auditing, and runtime suspension.
 *
 * Database credential transitions stay in @greenhouse/db. This module owns the
 * application concerns shared by the admin issuer and public completion route.
 */

import { randomUUID } from 'node:crypto';
import type { AccountPasswordLinkPurpose, DatabaseProvider, IssuedAccountPasswordLink, UserRow } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { escapeHtml } from '@greenhouse/utils/html';
import { getProductName } from '@greenhouse/utils/brand';
import type { PlatformAuditEvent } from '@greenhouse/platform-kernel';

import { getSharedMailboxCredentials, sendFromSharedMailbox } from './email/service.js';
import { chatRunRegistry } from './chat-runs.js';
import { connectionManager } from './ws/connection-manager.js';
import { getScheduler } from './scheduler/index.js';
import { getCloudAgentController } from './cloud-agent/index.js';
import { getWorkflowEngine } from './workflow-engine/index.js';
import { PLATFORM_ORG_ID } from './platform/runtime.js';

export type PasswordLinkAvailabilityReason =
  | 'missing_public_base_url'
  | 'invalid_public_base_url'
  | 'insecure_public_base_url'
  | 'shared_mailbox_unconfigured';

export type PasswordLinkCapability = { available: true } | { available: false; reason: PasswordLinkAvailabilityReason };

function resolvePublicBaseUrl(): { ok: true; baseUrl: string } | { ok: false; reason: PasswordLinkAvailabilityReason } {
  const raw = process.env.PUBLIC_BASE_URL?.trim();
  if (!raw) return { ok: false, reason: 'missing_public_base_url' };
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return { ok: false, reason: 'invalid_public_base_url' };
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      return { ok: false, reason: 'insecure_public_base_url' };
    }
    return { ok: true, baseUrl: url.href.replace(/\/$/, '') };
  } catch {
    return { ok: false, reason: 'invalid_public_base_url' };
  }
}

export function getPasswordLinkCapability(): PasswordLinkCapability {
  const base = resolvePublicBaseUrl();
  if (!base.ok) return { available: false, reason: base.reason };
  if (!getSharedMailboxCredentials()) return { available: false, reason: 'shared_mailbox_unconfigured' };
  return { available: true };
}

function passwordLinkUrl(token: string): string {
  const base = resolvePublicBaseUrl();
  if (!base.ok) throw new Error(`Password links unavailable: ${base.reason}`);
  return `${base.baseUrl}/#/activate?token=${encodeURIComponent(token)}`;
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

function purposeCopy(purpose: AccountPasswordLinkPurpose): {
  subject: string;
  heading: string;
  intro: string;
  action: string;
} {
  return purpose === 'invite'
    ? {
        subject: 'Set up your Greenhouse account',
        heading: 'Welcome to Greenhouse',
        intro: 'An administrator invited you to the Greenhouse workspace.',
        action: 'Set Greenhouse password',
      }
    : {
        subject: 'Reset your Greenhouse password',
        heading: 'Secure password reset',
        intro:
          'An administrator required a password reset for your Greenhouse account. Your old credentials are no longer valid.',
        action: 'Set new password',
      };
}

export async function deliverAccountPasswordLink(
  db: DatabaseProvider,
  issued: IssuedAccountPasswordLink,
  inviter: Pick<UserRow, 'id' | 'nickname' | 'email'>,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const capability = getPasswordLinkCapability();
  if (!capability.available) return { ok: false, error: `Password links unavailable: ${capability.reason}` };

  const copy = purposeCopy(issued.link.purpose);
  const url = passwordLinkUrl(issued.token);
  const expires = new Date(issued.link.expires_at).toISOString();
  const inviterLabel = `${inviter.nickname} (${inviter.email})`;
  const text = [
    copy.heading,
    '',
    copy.intro,
    `Account: ${issued.user.email}`,
    `Requested by: ${inviterLabel}`,
    `Expires: ${expires}`,
    '',
    `${copy.action}: ${url}`,
    '',
    'This one-time link can only set your password. If you did not expect it, contact your administrator.',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f7f5;color:#17221c;font-family:Inter,Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border:1px solid #dfe8e2;border-radius:16px"><tr><td style="padding:32px"><div style="font-size:14px;font-weight:700;color:#18864b;letter-spacing:.08em">${escapeHtml(getProductName().toUpperCase())}</div><h1 style="margin:16px 0 12px;font-size:26px;line-height:1.25">${escapeHtml(copy.heading)}</h1><p style="line-height:1.6;color:#526159">${escapeHtml(copy.intro)}</p><p style="line-height:1.6;color:#526159"><strong>Account:</strong> ${escapeHtml(issued.user.email)}<br><strong>Requested by:</strong> ${escapeHtml(inviterLabel)}<br><strong>Expires:</strong> ${escapeHtml(expires)}</p><p style="margin:28px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#18864b;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">${escapeHtml(copy.action)}</a></p><p style="font-size:13px;line-height:1.6;color:#728078">This one-time link can only set your password. If you did not expect it, contact your administrator.</p></td></tr></table></td></tr></table></body></html>`;

  return sendFromSharedMailbox(
    db,
    { address: issued.user.email, name: issued.user.nickname },
    { subject: copy.subject, body_text: text, body_html: html },
    { userId: inviter.id, origin: 'account-security' },
  );
}

export async function recordAccountSecurityAudit(
  db: DatabaseProvider,
  input: {
    actorId: string;
    actorType?: PlatformAuditEvent['actorType'];
    requestId?: string;
    targetUserId: string;
    linkId?: string;
    actionId: string;
    result: PlatformAuditEvent['result'];
    summary?: Record<string, unknown>;
  },
): Promise<void> {
  await db.platform.recordAudit({
    orgId: PLATFORM_ORG_ID,
    actorId: input.actorId,
    actorType: input.actorType ?? 'human',
    requestId: input.requestId ?? randomUUID(),
    resource: { appId: 'platform', moduleId: 'identity', entityId: 'user', recordId: input.targetUserId },
    actionId: input.actionId,
    capability: 'platform.user.manage',
    result: input.result,
    summary: { ...(input.linkId ? { link_id: input.linkId } : {}), ...(input.summary ?? {}) },
  });
}

/** Security state is already committed; runtime cleanup is best-effort defence in depth. */
export async function suspendUserRuntime(userId: string): Promise<void> {
  chatRunRegistry.stopForUser(userId);
  connectionManager.disconnectUser(userId, 4001, 'Credentials reset by administrator');

  const work: Promise<unknown>[] = [];
  const scheduler = getScheduler();
  if (scheduler) work.push(scheduler.pauseUser(userId));
  const cloudAgent = getCloudAgentController();
  if (cloudAgent) work.push(cloudAgent.cancelRunsForUser(userId));
  try {
    work.push(getWorkflowEngine().cancelRunsForUser(userId));
  } catch {
    // Engine is not initialized in small route tests and early boot only.
  }

  const results = await Promise.allSettled(work);
  for (const result of results) {
    if (result.status === 'rejected') logger.error('[account-security] runtime suspension failed', result.reason);
  }
}

export async function resumeUserRuntime(userId: string): Promise<void> {
  try {
    await getScheduler()?.resumeUser(userId);
  } catch (error) {
    logger.error('[account-security] automation resume failed', toErrorMessage(error));
  }
}
