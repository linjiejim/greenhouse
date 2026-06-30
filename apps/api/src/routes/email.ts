/**
 * Email account management routes — /api/email
 *
 * Generic IMAP/SMTP accounts only. The whole route requires internal auth.
 *
 * GET    /api/email/accounts              — 列出我的邮箱账号 (super: 可看所有人)
 * POST   /api/email/accounts              — 添加 IMAP/SMTP 邮箱
 * PUT    /api/email/accounts/:id          — 更新邮箱配置
 * DELETE /api/email/accounts/:id          — 删除邮箱
 * POST   /api/email/accounts/:id/test     — 测试连接
 * GET    /api/email/accounts/:id/folders  — 获取文件夹/标签列表
 * GET    /api/email/accounts/:id/messages — 获取邮件列表
 * GET    /api/email/accounts/:id/messages/:msgId — 获取邮件详情
 * POST   /api/email/accounts/:id/send     — 发送邮件
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { getDb } from '@greenhouse/db';
import { getAuthUser, requireInternal } from '../auth/middleware.js';
import {
  encryptCredentials,
  createEmailClient,
  testEmailConnection,
  MAX_EMAIL_ACCOUNTS,
  isEncryptionConfigured,
} from '../email/index.js';
import type { ImapCredentials } from '../email/index.js';
import { logger } from '@greenhouse/utils/logger';
import { isAllowedMailHost, isValidEmail, validateEmailAddresses } from '../email/security.js';
import type { AppEnv } from '../app-env.js';

// ─── Helper: ownership check ──────────────────────────────

// Typed Context (not `any`): an `any` return from a handler erases the route
// from the inferred AppType schema, breaking hc clients for /accounts/:id.
async function getOwnedAccount(c: Context<AppEnv>, id: number) {
  const user = getAuthUser(c);
  const db = getDb();
  const account = await db.emailAccounts.getById(id);
  if (!account) return { error: c.json({ error: 'Account not found' }, 404) };
  if (account.user_id !== user.id && user.role !== 'super') {
    return { error: c.json({ error: 'Forbidden' }, 403) };
  }
  return { account, user };
}

const emailRoutes = new Hono<AppEnv>()
  // The whole email surface is internal-only.
  .use('/accounts/*', requireInternal())
  .use('/accounts', requireInternal())

  // ─── GET /accounts — list email accounts ──────────────────

  .get('/accounts', async (c) => {
    const user = getAuthUser(c);
    const db = getDb();
    const showAll = c.req.query('all') === 'true' && user.role === 'super';
    const accounts = showAll ? await db.emailAccounts.listAll() : await db.emailAccounts.listByUser(user.id);

    return c.json({
      accounts: accounts.map((a) => ({
        id: a.id,
        user_id: a.user_id,
        provider: a.provider,
        email_address: a.email_address,
        display_name: a.display_name,
        config: a.config,
        status: a.status,
        error_message: a.error_message,
        last_synced_at: a.last_synced_at,
        created_at: a.created_at,
        updated_at: a.updated_at,
      })),
    });
  })
  // ─── POST /accounts — add IMAP/SMTP account ──────────────

  .post('/accounts', async (c) => {
    if (!isEncryptionConfigured()) {
      return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not configured' }, 503);
    }

    const user = getAuthUser(c);
    const db = getDb();

    // Check limit
    const count = await db.emailAccounts.countByUser(user.id);
    if (count >= MAX_EMAIL_ACCOUNTS) {
      return c.json({ error: `Maximum ${MAX_EMAIL_ACCOUNTS} email accounts allowed` }, 400);
    }

    const body = await c.req.json();
    const { email_address, display_name, imap_host, imap_port, smtp_host, smtp_port, username, password, use_tls } =
      body;

    if (!email_address || !smtp_host || !smtp_port || !username || !password) {
      return c.json({ error: 'Missing required fields: email_address, smtp_host, smtp_port, username, password' }, 400);
    }

    // Validate email address format
    if (!isValidEmail(email_address)) {
      return c.json({ error: 'Invalid email address format' }, 400);
    }

    // SSRF prevention: block internal/reserved hosts
    const effectiveImapHost = imap_host || smtp_host;
    if (!isAllowedMailHost(smtp_host)) {
      return c.json({ error: 'SMTP host is not allowed (internal/reserved address)' }, 400);
    }
    if (!isAllowedMailHost(effectiveImapHost)) {
      return c.json({ error: 'IMAP host is not allowed (internal/reserved address)' }, 400);
    }

    const creds: ImapCredentials = {
      type: 'imap',
      imap_host: effectiveImapHost,
      imap_port: imap_port ?? 993,
      smtp_host,
      smtp_port,
      username,
      password,
      use_tls: use_tls ?? true,
    };

    const account = await db.emailAccounts.create({
      user_id: user.id,
      provider: 'imap',
      email_address,
      display_name: display_name || undefined,
      credentials: encryptCredentials(creds),
    });

    logger.info(`[Email] 📧 IMAP account added: ${email_address} by user ${user.id}`);

    return c.json(
      {
        account: {
          id: account.id,
          provider: account.provider,
          email_address: account.email_address,
          status: account.status,
          created_at: account.created_at,
        },
        message: 'Account added. Run connection test to verify.',
      },
      201,
    );
  })
  // ─── PUT /accounts/:id — update account ───────────────────

  .put('/accounts/:id', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid account ID' }, 400);

    const result = await getOwnedAccount(c, id);
    if ('error' in result && !('account' in result)) return result.error;

    const body = await c.req.json();
    const updates: Record<string, unknown> = {};
    if (body.display_name !== undefined) updates.display_name = body.display_name;
    if (body.config !== undefined) updates.config = body.config;
    if (body.status !== undefined) updates.status = body.status;

    const updated = await getDb().emailAccounts.update(id, updates);
    return c.json({
      account: {
        id: updated!.id,
        provider: updated!.provider,
        email_address: updated!.email_address,
        display_name: updated!.display_name,
        status: updated!.status,
        updated_at: updated!.updated_at,
      },
    });
  })
  // ─── DELETE /accounts/:id — delete account ────────────────

  .delete('/accounts/:id', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid account ID' }, 400);

    const result = await getOwnedAccount(c, id);
    if ('error' in result && !('account' in result)) return result.error;

    await getDb().emailAccounts.delete(id);
    logger.info(`[Email] 🗑️ Account deleted: ${result.account!.email_address}`);
    return c.json({ message: `Account "${result.account!.email_address}" deleted` });
  })
  // ─── POST /accounts/:id/test — test connection ───────────

  .post('/accounts/:id/test', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid account ID' }, 400);

    const result = await getOwnedAccount(c, id);
    if ('error' in result && !('account' in result)) return result.error;

    const testResult = await testEmailConnection(getDb(), result.account!);
    return c.json(testResult);
  })
  // ─── GET /accounts/:id/folders — list folders ─────────────

  .get('/accounts/:id/folders', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid account ID' }, 400);

    const result = await getOwnedAccount(c, id);
    if ('error' in result && !('account' in result)) return result.error;

    const client = await createEmailClient(getDb(), result.account!);
    const folders = await client.listFolders();
    return c.json({ folders });
  })
  // ─── GET /accounts/:id/messages — list messages ──────────

  .get('/accounts/:id/messages', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid account ID' }, 400);

    const result = await getOwnedAccount(c, id);
    if ('error' in result && !('account' in result)) return result.error;

    const client = await createEmailClient(getDb(), result.account!);
    const listResult = await client.listMessages({
      folder: c.req.query('folder') ?? undefined,
      query: c.req.query('q') ?? undefined,
      limit: parseInt(c.req.query('limit') ?? '20'),
      page_token: c.req.query('page_token') ?? undefined,
    });
    return c.json(listResult);
  })
  // ─── GET /accounts/:id/messages/:msgId — get detail ──────

  .get('/accounts/:id/messages/:msgId', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid account ID' }, 400);

    const result = await getOwnedAccount(c, id);
    if ('error' in result && !('account' in result)) return result.error;

    const client = await createEmailClient(getDb(), result.account!);
    const message = await client.getMessage(c.req.param('msgId'));
    return c.json({ message });
  })
  // ─── POST /accounts/:id/send — send email ────────────────

  .post('/accounts/:id/send', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid account ID' }, 400);

    const result = await getOwnedAccount(c, id);
    if ('error' in result && !('account' in result)) return result.error;

    const body = await c.req.json();
    if (!body.to?.length || !body.subject) {
      return c.json({ error: 'Missing required fields: to, subject' }, 400);
    }

    // Validate all recipient addresses
    const toError = validateEmailAddresses(body.to, 'to');
    if (toError) return c.json({ error: toError }, 400);
    if (body.cc?.length) {
      const ccError = validateEmailAddresses(body.cc, 'cc');
      if (ccError) return c.json({ error: ccError }, 400);
    }
    if (body.bcc?.length) {
      const bccError = validateEmailAddresses(body.bcc, 'bcc');
      if (bccError) return c.json({ error: bccError }, 400);
    }

    const client = await createEmailClient(getDb(), result.account!);
    const sendResult = await client.sendEmail({
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      body_text: body.body_text,
      body_html: body.body_html,
      in_reply_to: body.in_reply_to,
      references: body.references,
    });

    logger.info(`[Email] ✉️ Sent from ${result.account!.email_address}: "${body.subject}"`);
    return c.json({ message: 'Email sent successfully', messageId: sendResult.messageId });
  });

export { emailRoutes };
