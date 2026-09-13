/**
 * Chat artifact action receipts — /api/artifact-actions
 *
 * GET /api/artifact-actions/:id — 读取当前用户的一条持久化卡片操作回执
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { publicArtifactReceipt } from '../chat-artifact-actions.js';

const artifactActions = new Hono<AppEnv>().get('/:id', async (c) => {
  const receipt = await getDb().chatArtifactReceipts.getForUser(c.req.param('id'), getAuthUser(c).id);
  if (!receipt) return c.json({ error: 'Artifact receipt not found' }, 404);
  return c.json({ receipt: publicArtifactReceipt(receipt) });
});

export default artifactActions;
