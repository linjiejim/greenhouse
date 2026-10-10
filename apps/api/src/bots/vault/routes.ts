/**
 * 密码库路由 — /api/bots/vault（成员自己的登录凭证，Bot 可代填但永远看不到）
 *
 * GET    /api/bots/vault       — 条目列表（只有元数据：名称、网站、打码用户名）+ 是否可用
 * POST   /api/bots/vault       — 新建条目（label + origins 必填；秘密字段只写不读）
 * PATCH  /api/bots/vault/:id   — 修改条目（省略的秘密字段保持不变，空字符串 = 清除）
 * DELETE /api/bots/vault/:id   — 删除条目
 * GET    /api/bots/vault/log   — 最近的使用记录（只记元数据）
 *
 * Mounted behind requireInternal() + requireFeature('bots'). Owner-scoped:
 * another member's entry is indistinguishable from a missing one (404).
 * Secrets are write-only — no response ever carries one, and request bodies
 * are never logged. Errors: 503 `vault_unavailable` when the deployment has
 * no usable vault key (crypto.ts); 400 `origin_invalid` / `origin_forbidden`
 * / `label_invalid` / `totp_invalid` / `invalid` for bad input.
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §8; HTTP contract in ../AGENTS.md.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getDb } from '@greenhouse/db';
import type { AppEnv } from '../../app-env.js';
import { getAuthUser } from '../../auth/middleware.js';
import { VaultError, isVaultAvailable } from './crypto.js';
import { createVaultItem, deleteVaultItem, listVaultAccess, listVaultItems, updateVaultItem } from './service.js';

const writeSchema = z
  .object({
    label: z.string().max(200).optional(),
    origins: z.array(z.string().max(300)).max(20).optional(),
    username: z.string().max(320).optional(),
    password: z.string().max(1024).optional(),
    totp: z.string().max(1024).optional(),
    policy: z.enum(['ask', 'auto']).optional(),
    // Revoke only: the remaining "always allow on this site" grants. A grant is
    // only ever ADDED by the member's choice on an approval card.
    always_origins: z.array(z.string().max(300)).max(50).optional(),
  })
  .strict();

function vaultError(c: Context<AppEnv>, err: unknown) {
  if (!(err instanceof VaultError)) throw err;
  if (err.code === 'vault_unavailable') return c.json({ error: err.message, code: err.code }, 503);
  if (err.code === 'not_found') return c.json({ error: err.message, code: err.code }, 404);
  return c.json({ error: err.message, code: err.code }, 400);
}

const INVALID_BODY = { error: 'Invalid vault entry', code: 'invalid' } as const;

export function createBotsVaultRoutes() {
  return new Hono<AppEnv>()
    .get('/', async (c) => {
      const user = getAuthUser(c);
      const items = await listVaultItems(getDb(), user.id);
      return c.json({ items, available: isVaultAvailable() });
    })
    .get('/log', async (c) => {
      const user = getAuthUser(c);
      return c.json({ entries: await listVaultAccess(getDb(), user.id) });
    })
    .post('/', async (c) => {
      const user = getAuthUser(c);
      const parsed = writeSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json(INVALID_BODY, 400);
      if (!parsed.data.label || !parsed.data.origins) {
        return c.json({ error: 'A name and at least one site are required', code: 'invalid' }, 400);
      }
      try {
        const item = await createVaultItem(getDb(), user.id, parsed.data);
        return c.json({ item }, 201);
      } catch (err) {
        return vaultError(c, err);
      }
    })
    .patch('/:id', async (c) => {
      const user = getAuthUser(c);
      const parsed = writeSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json(INVALID_BODY, 400);
      try {
        const item = await updateVaultItem(getDb(), user.id, c.req.param('id'), parsed.data);
        return c.json({ item });
      } catch (err) {
        return vaultError(c, err);
      }
    })
    .delete('/:id', async (c) => {
      const user = getAuthUser(c);
      const removed = await deleteVaultItem(getDb(), user.id, c.req.param('id'));
      if (!removed) return c.json({ error: 'Vault entry not found', code: 'not_found' }, 404);
      return c.json({ ok: true as const });
    });
}
