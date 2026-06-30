/**
 * 外部 API 会话端点 — /api/v1/sessions
 *
 * GET    /api/v1/sessions/:id          — 查询会话信息
 * GET    /api/v1/sessions/:id/messages — 查询会话消息（分页）
 * DELETE /api/v1/sessions/:id          — 归档会话（软删除）
 *
 * 认证：Authorization: Bearer (Server-to-Server)
 * 隔离：只能访问属于本 app_id 的会话
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { getApiClient, getClientIP } from '../../auth/api-key.js';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { AppEnv } from '../../app-env.js';

const sessions = new Hono<AppEnv>()
  // ─── GET /api/v1/sessions/:id — 查询会话信息 ──────────────
  .get('/:id', async (c) => {
    const client = getApiClient(c);
    const sessionId = c.req.param('id');

    const session = await getDb().sessions.getById(sessionId);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    // Verify ownership
    if (session.app_id !== client.app_id) {
      return c.json({ error: 'Session does not belong to this API client' }, 403);
    }

    const messageCount = await getDb().sessions.getMessageCount(sessionId);
    const usage = await getDb().sessions.getUsage(sessionId);

    // Parse metadata
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(session.metadata || '{}');
    } catch {
      /* ignore */
    }

    return c.json({
      id: session.id,
      title: session.title,
      status: session.status,
      profile_id: session.profile_id,
      app_id: session.app_id,
      meta,
      message_count: messageCount,
      usage: {
        input_tokens: usage.totalInputTokens,
        output_tokens: usage.totalOutputTokens,
        duration_ms: usage.totalDurationMs,
      },
      created_at: session.created_at,
      updated_at: session.updated_at,
    });
  })
  // ─── GET /api/v1/sessions/:id/messages — 查询会话消息 ────
  .get('/:id/messages', async (c) => {
    const client = getApiClient(c);
    const sessionId = c.req.param('id');

    const session = await getDb().sessions.getById(sessionId);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    // Verify ownership
    if (session.app_id !== client.app_id) {
      return c.json({ error: 'Session does not belong to this API client' }, 403);
    }

    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    const messages = await getDb().sessions.getMessages(sessionId, { limit, offset });
    const total = await getDb().sessions.getMessageCount(sessionId);

    return c.json({
      session_id: sessionId,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        references: m.role === 'assistant' ? safeJsonParse(m.references_, []) : undefined,
        created_at: m.created_at,
      })),
      total,
      has_more: offset + limit < total,
    });
  })
  // ─── DELETE /api/v1/sessions/:id — 归档会话 ──────────────
  .delete('/:id', async (c) => {
    const client = getApiClient(c);
    const sessionId = c.req.param('id');

    const session = await getDb().sessions.getById(sessionId);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    // Verify ownership
    if (session.app_id !== client.app_id) {
      return c.json({ error: 'Session does not belong to this API client' }, 403);
    }

    // Soft delete: set status to archived
    await getDb().sessions.updateStatus(sessionId, 'archived');

    // Record audit
    try {
      await getDb().apiAudit.record({
        app_id: client.app_id,
        endpoint: `/api/v1/sessions/${sessionId}`,
        method: 'DELETE',
        session_id: sessionId,
        status_code: 200,
        ip_address: getClientIP(c),
      });
    } catch {
      /* ignore audit errors */
    }

    return c.json({ ok: true, session_id: sessionId, status: 'archived' });
  });

export default sessions;
