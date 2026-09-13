/**
 * Email account routes — /api/email
 *
 * GET    /api/email/presets        — 可选的邮箱预设（host/port/说明键）
 * GET    /api/email/accounts       — 当前用户绑定的邮箱列表（不含密码）
 * POST   /api/email/accounts       — 新增绑定（保存前必须连接测试通过）
 * PUT    /api/email/accounts/:id   — 更新绑定（密码可选，留空则不改）
 * DELETE /api/email/accounts/:id   — 解除绑定
 * POST   /api/email/accounts/:id/test — 重新测试既有绑定的连接
 * GET    /api/email/shared         — 共享邮箱是否可用（super 才看得到地址）
 *
 * Permission: internal + `email` feature flag（挂载点统一加守卫）。
 *
 * 这里是协议适配层：连接、发信与限额都在 email/service.ts 与
 * email/imap-smtp-client.ts，与 Agent 工具共用同一份实现。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@greenhouse/db';
import { EMAIL_PRESETS, getEmailPreset } from '@greenhouse/types/email';
import { isUniqueViolation, toErrorMessage } from '@greenhouse/utils/error';
import { nowIso } from '@greenhouse/utils/date';
import type { EmailAccountRow } from '@greenhouse/db';
import type { AuthUser } from '../auth/token.js';
import type { AppEnv } from '../app-env.js';
import { encryptToken, isEncryptionConfigured } from '../auth/crypto.js';
import { ImapSmtpClient } from '../email/imap-smtp-client.js';
import { getSharedMailboxCredentials, toCredentials } from '../email/service.js';
import { isValidEmail } from '../email/security.js';

/** Password is write-only: it goes in through create/update and never comes back. */
function toView(row: EmailAccountRow) {
  return {
    id: row.id,
    email_address: row.email_address,
    display_name: row.display_name,
    preset: row.preset,
    imap_host: row.imap_host,
    imap_port: row.imap_port,
    smtp_host: row.smtp_host,
    smtp_port: row.smtp_port,
    use_tls: row.use_tls,
    use_proxy: row.use_proxy,
    username: row.username,
    status: row.status,
    error_message: row.error_message,
    last_verified_at: row.last_verified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const presetIds = EMAIL_PRESETS.map((p) => p.id) as [string, ...string[]];

const createAccountSchema = z.object({
  email_address: z.string().trim().min(3).max(254),
  display_name: z.string().max(120).nullish(),
  preset: z.enum(presetIds).default('custom'),
  imap_host: z.string().trim().min(1).max(253),
  imap_port: z.number().int().min(1).max(65535),
  smtp_host: z.string().trim().min(1).max(253),
  smtp_port: z.number().int().min(1).max(65535),
  use_tls: z.boolean().default(true),
  use_proxy: z.boolean().default(false),
  username: z.string().trim().min(1).max(254).optional(),
  // Trimmed because copy-pasted app passwords routinely carry a stray trailing
  // space/newline (Gmail even DISPLAYS them with grouping spaces), and a mail
  // password that genuinely starts or ends with whitespace does not exist in
  // practice. Inner spaces are preserved.
  password: z.string().trim().min(1).max(512),
});

const updateAccountSchema = createAccountSchema.partial().omit({ email_address: true, preset: true });

export function createEmailRoutes() {
  return (
    new Hono<AppEnv>()
      /** GET /api/email/presets — provider presets (single source of truth in @greenhouse/types). */
      .get('/presets', (c) => c.json({ presets: EMAIL_PRESETS }))

      /** GET /api/email/shared — whether the shared mailbox exists; address for supers only. */
      .get('/shared', (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);
        const creds = getSharedMailboxCredentials();
        const available = creds !== null && user.role === 'super';
        return c.json({
          available,
          address: available ? creds!.email_address : null,
          configured: creds !== null,
        });
      })

      /** GET /api/email/accounts — the caller's own bindings. */
      .get('/accounts', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);
        const rows = await getDb().email.listAccountsByUser(user.id);
        return c.json({ accounts: rows.map(toView) });
      })

      /**
       * POST /api/email/accounts — bind a mailbox.
       *
       * The connection is tested BEFORE the row is written: a binding that
       * cannot read or send is worse than no binding, because the agent will
       * cheerfully try to use it.
       */
      .post('/accounts', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);
        if (!isEncryptionConfigured()) {
          return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not configured on this server.' }, 500);
        }

        const parsed = createAccountSchema.safeParse(await c.req.json().catch(() => ({})));
        if (!parsed.success) {
          return c.json({ error: `Invalid request: ${parsed.error.issues[0]?.message ?? 'bad body'}` }, 400);
        }
        const input = parsed.data;
        if (!isValidEmail(input.email_address)) {
          return c.json({ error: `"${input.email_address}" is not a valid email address.` }, 400);
        }

        const username = input.username?.trim() || input.email_address;
        const test = await new ImapSmtpClient({
          email_address: input.email_address,
          display_name: input.display_name ?? null,
          imap_host: input.imap_host,
          imap_port: input.imap_port,
          smtp_host: input.smtp_host,
          smtp_port: input.smtp_port,
          use_tls: input.use_tls,
          use_proxy: input.use_proxy,
          username,
          password: input.password,
        }).testConnection();

        if (!test.imap.ok || !test.smtp.ok) {
          return c.json({ error: 'Connection test failed — the account was not saved.', test }, 400);
        }

        try {
          const row = await getDb().email.createAccount({
            user_id: user.id,
            email_address: input.email_address,
            display_name: input.display_name ?? null,
            preset: getEmailPreset(input.preset)?.id ?? 'custom',
            imap_host: input.imap_host,
            imap_port: input.imap_port,
            smtp_host: input.smtp_host,
            smtp_port: input.smtp_port,
            use_tls: input.use_tls,
            use_proxy: input.use_proxy,
            username,
            password_encrypted: encryptToken(input.password),
          });
          const verified = await getDb().email.updateAccount(row.id, { last_verified_at: nowIso() });
          return c.json({ account: toView(verified ?? row), test }, 201);
        } catch (err) {
          if (isUniqueViolation(err)) {
            return c.json({ error: `${input.email_address} is already bound to your account.` }, 409);
          }
          return c.json({ error: toErrorMessage(err) }, 500);
        }
      })

      /** PUT /api/email/accounts/:id — update connection settings and/or password. */
      .put('/accounts/:id', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const id = Number.parseInt(c.req.param('id'), 10);
        if (!Number.isInteger(id)) return c.json({ error: 'Invalid account id' }, 400);

        const existing = await getDb().email.getAccount(id);
        if (!existing || existing.user_id !== user.id) return c.json({ error: 'Account not found' }, 404);

        const parsed = updateAccountSchema.safeParse(await c.req.json().catch(() => ({})));
        if (!parsed.success) {
          return c.json({ error: `Invalid request: ${parsed.error.issues[0]?.message ?? 'bad body'}` }, 400);
        }
        const input = parsed.data;

        const merged = {
          ...toCredentials(existing),
          ...(input.display_name !== undefined ? { display_name: input.display_name } : {}),
          ...(input.imap_host !== undefined ? { imap_host: input.imap_host } : {}),
          ...(input.imap_port !== undefined ? { imap_port: input.imap_port } : {}),
          ...(input.smtp_host !== undefined ? { smtp_host: input.smtp_host } : {}),
          ...(input.smtp_port !== undefined ? { smtp_port: input.smtp_port } : {}),
          ...(input.use_tls !== undefined ? { use_tls: input.use_tls } : {}),
          ...(input.use_proxy !== undefined ? { use_proxy: input.use_proxy } : {}),
          ...(input.username !== undefined ? { username: input.username } : {}),
          ...(input.password !== undefined ? { password: input.password } : {}),
        };

        const test = await new ImapSmtpClient(merged).testConnection();
        if (!test.imap.ok || !test.smtp.ok) {
          return c.json({ error: 'Connection test failed — nothing was changed.', test }, 400);
        }

        const updated = await getDb().email.updateAccount(id, {
          display_name: merged.display_name,
          imap_host: merged.imap_host,
          imap_port: merged.imap_port,
          smtp_host: merged.smtp_host,
          smtp_port: merged.smtp_port,
          use_tls: merged.use_tls,
          use_proxy: merged.use_proxy,
          username: merged.username,
          ...(input.password !== undefined ? { password_encrypted: encryptToken(input.password) } : {}),
          status: 'active',
          error_message: null,
          last_verified_at: nowIso(),
        });
        return c.json({ account: toView(updated!), test });
      })

      /** DELETE /api/email/accounts/:id — unbind. */
      .delete('/accounts/:id', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const id = Number.parseInt(c.req.param('id'), 10);
        if (!Number.isInteger(id)) return c.json({ error: 'Invalid account id' }, 400);

        const existing = await getDb().email.getAccount(id);
        if (!existing || existing.user_id !== user.id) return c.json({ error: 'Account not found' }, 404);

        await getDb().email.deleteAccount(id);
        return c.json({ deleted: true, id });
      })

      /**
       * POST /api/email/accounts/:id/test — re-test an existing binding.
       *
       * Records the verdict on the row so the list can show a mailbox that has
       * started failing (expired app password, revoked client access) instead of
       * letting the agent discover it mid-conversation.
       */
      .post('/accounts/:id/test', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const id = Number.parseInt(c.req.param('id'), 10);
        if (!Number.isInteger(id)) return c.json({ error: 'Invalid account id' }, 400);

        const existing = await getDb().email.getAccount(id);
        if (!existing || existing.user_id !== user.id) return c.json({ error: 'Account not found' }, 404);

        const test = await new ImapSmtpClient(toCredentials(existing)).testConnection();
        const ok = test.imap.ok && test.smtp.ok;
        const updated = await getDb().email.updateAccount(id, {
          status: ok ? 'active' : 'error',
          error_message: ok ? null : [test.imap.error, test.smtp.error].filter(Boolean).join(' | '),
          ...(ok ? { last_verified_at: nowIso() } : {}),
        });
        return c.json({ account: toView(updated!), test });
      })
  );
}
