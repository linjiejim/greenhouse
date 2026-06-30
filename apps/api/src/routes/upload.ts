/**
 * Upload routes — /api/upload
 *
 * POST /api/upload      — 上传图片（用于聊天图片分析，限5MB，支持jpg/png/webp/gif）
 * GET  /api/upload/:id  — 获取已上传的图片文件
 */

import { Hono } from 'hono';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { validateMagicBytes } from '../security.js';
import { putUpload, getUpload } from '../storage/uploads.js';
import type { AppEnv } from '../app-env.js';
const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const upload = new Hono<AppEnv>()
  /**
   * POST /api/upload
   * Content-Type: multipart/form-data
   * Body: file (image)
   * Returns: { id, url, mime_type, size }
   */
  .post('/', async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file provided. Send multipart/form-data with field "file".' }, 400);
    }

    // Validate type
    if (!ALLOWED_TYPES.has(file.type)) {
      return c.json(
        {
          error: `Unsupported file type: ${file.type}. Allowed: ${[...ALLOWED_TYPES].join(', ')}`,
        },
        400,
      );
    }

    // Validate size
    if (file.size > MAX_SIZE) {
      return c.json(
        {
          error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: 5MB`,
        },
        400,
      );
    }

    // Generate unique filename
    const ext = extname(file.name || '.jpg') || '.jpg';
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;

    const buffer = Buffer.from(await file.arrayBuffer());

    // Validate magic bytes match claimed MIME type
    if (!validateMagicBytes(buffer, file.type)) {
      return c.json(
        {
          error: `File content does not match declared type: ${file.type}. File may be corrupted or misidentified.`,
        },
        400,
      );
    }

    try {
      await putUpload(id, buffer, file.type);
    } catch (err) {
      logger.error(`[Upload] ❌ Failed to store ${id}: ${toErrorMessage(err)}`);
      return c.json({ error: 'Failed to store file' }, 500);
    }

    logger.info(`[Upload] 📸 Saved: ${id} (${file.type}, ${(file.size / 1024).toFixed(1)}KB)`);

    return c.json({
      id,
      url: `/api/upload/${id}`,
      mime_type: file.type,
      size: file.size,
    });
  })
  /**
   * GET /api/upload/:id — serve uploaded image
   */
  .get('/:id', async (c) => {
    const id = c.req.param('id');

    // Security: sanitize filename (no path traversal)
    if (id.includes('/') || id.includes('..') || id.includes('\\')) {
      return c.json({ error: 'Invalid file ID' }, 400);
    }

    let obj;
    try {
      obj = await getUpload(id);
    } catch (err) {
      logger.error(`[Upload] ❌ Failed to read ${id}: ${toErrorMessage(err)}`);
      return c.json({ error: 'Failed to read file' }, 500);
    }
    if (!obj) {
      return c.json({ error: 'File not found' }, 404);
    }

    c.header('Content-Type', obj.contentType);
    c.header('Cache-Control', 'public, max-age=86400');
    // Hand Hono a freshly-backed ArrayBuffer (Node Buffer<ArrayBufferLike> isn't
    // assignable to c.body's overloads).
    return c.body(Uint8Array.from(obj.buffer).buffer);
  });

export default upload;
