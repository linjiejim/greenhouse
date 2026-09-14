/**
 * Chat file handles — /api/chat-files
 *
 * POST /api/chat-files/upload      — 上传任意类型附件到某个会话（multipart）
 * GET  /api/chat-files/:id/content — 鉴权下载
 *
 * ⚠️ 上传挂在 `/upload` 而不是裸路径：`index.ts` 的守卫是
 * `.use('/api/chat-files/*', requireInternal())`，而 Hono 的 `/*` **匹配不到裸
 * 路径本身**——挂在 `/` 上的写入口会绕过角色守卫，只剩全局 Bearer 兜底。
 *
 * File ids are persisted in tool outputs and dispatch cards, but possession of
 * an id is never authorization: access always follows the parent session's
 * read policy.
 *
 * **图片不走这里**：浏览器 `<img src>` 带不了 Bearer，所以图片继续走
 * `/api/upload` 的扁平 id + 公开读路径。那条豁免**只对图片开**——任何其它类型
 * 的文件放进公开读，等于给每份 PDF/xlsx 发一个免登录 URL（附件收敛 spec D2）。
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { getDb } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import { contentDisposition } from '../http/content-disposition.js';
import { canAccessSession } from '../sessions/access.js';
import { getObjectAtKey, presignGetUrl, putObjectAtKey } from '../storage/uploads.js';
import { sanitizeUploadName } from '../storage/filename.js';
import type { AppEnv } from '../app-env.js';

/**
 * Same ceiling as a mission input, deliberately: a chat attachment must stay
 * promotable into a sandbox run (spec D6), so a lower limit here would only
 * produce files that can be uploaded but never dispatched.
 */
export const MAX_CHAT_FILE_BYTES = 100 * 1024 * 1024;
const MAX_CHAT_FILE_BODY_BYTES = MAX_CHAT_FILE_BYTES + 1024 * 1024;

/**
 * Per-user ceiling on uploaded bytes — the necessary counterpart to D6's
 * generous per-file limit, without which a conversation is an unbounded place
 * to park gigabytes.
 */
export const MAX_USER_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

function chatFileKey(userId: string, fileId: string, name: string): string {
  return `chat-files/${userId}/${fileId}/${name}`;
}

const chatFiles = new Hono<AppEnv>()
  .post(
    '/upload',
    // Cut an oversize body at the socket instead of letting parseBody() buffer
    // it whole first; the headroom covers multipart framing.
    bodyLimit({
      maxSize: MAX_CHAT_FILE_BODY_BYTES,
      onError: (c) => c.json({ error: `file exceeds ${MAX_CHAT_FILE_BYTES} bytes` }, 413),
    }),
    async (c) => {
      const user = getAuthUser(c);
      const form = await c.req.parseBody().catch(() => null);
      const file = form?.['file'];
      const sessionId = form?.['session_id'];
      if (!(file instanceof File)) return c.json({ error: 'multipart field "file" is required' }, 400);
      if (typeof sessionId !== 'string' || !sessionId) {
        return c.json({ error: 'multipart field "session_id" is required' }, 400);
      }
      if (file.size > MAX_CHAT_FILE_BYTES) {
        return c.json({ error: `file exceeds ${MAX_CHAT_FILE_BYTES} bytes` }, 413);
      }

      // Writing is stricter than reading: a shared session stays readable by
      // its recipients, but only the owner may attach to it.
      const session = await getDb().sessions.getById(sessionId);
      if (!session || session.user_id !== user.id) return c.json({ error: 'Session not found' }, 404);

      const used = await getDb().chatFiles.totalUploadedBytes(user.id);
      if (used + file.size > MAX_USER_UPLOAD_BYTES) {
        return c.json({ error: 'upload quota exceeded — remove some attachments first' }, 413);
      }

      const name = sanitizeUploadName(file.name || 'file');
      if (!name) return c.json({ error: 'filename is unusable' }, 400);

      const contentType = file.type || 'application/octet-stream';
      // The key carries its own random segment rather than the row id: the row
      // is created after the bytes land, and the object must be unguessable
      // regardless (it is also reachable via a presigned URL).
      const storageKey = chatFileKey(user.id, randomUUID(), name);
      await putObjectAtKey(storageKey, Buffer.from(await file.arrayBuffer()), contentType);

      const row = await getDb().chatFiles.create({
        session_id: session.id,
        name,
        content_type: contentType,
        size: file.size,
        storage_key: storageKey,
        source: 'user',
        created_by: user.id,
      });
      return c.json({ file: { id: row.id, name: row.name, content_type: row.content_type, size: row.size } }, 201);
    },
  )

  .get('/:id/content', async (c) => {
    const file = await getDb().chatFiles.getById(c.req.param('id'));
    if (!file) return c.json({ error: 'File not found' }, 404);

    const session = await getDb().sessions.getById(file.session_id);
    if (!session || !(await canAccessSession(getAuthUser(c), session))) {
      return c.json({ error: 'File not found' }, 404);
    }

    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const signed = await presignGetUrl(file.storage_key, 120, {
      filename: file.name,
      contentType: file.content_type,
    });
    if (signed) return c.redirect(signed, 302);

    const object = await getObjectAtKey(file.storage_key);
    if (!object) return c.json({ error: 'File not found' }, 404);
    c.header('Content-Type', file.content_type);
    c.header('Content-Disposition', contentDisposition(file.name));
    c.header('Content-Length', String(object.buffer.length));
    return c.body(Uint8Array.from(object.buffer).buffer);
  });

export default chatFiles;
