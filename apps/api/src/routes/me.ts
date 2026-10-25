/**
 * The signed-in member's own settings that follow the account across devices.
 *
 * GET   /api/me/preferences   → MemberPreferences ({ fontScale })
 * PATCH /api/me/preferences   { fontScale?: 0.8 | 0.85 | 0.9 | 1 | 1.1 | 1.2 | 1.35 } → MemberPreferences
 * POST  /api/me/feedback      { message, context? } → 201 { id }
 *
 * Stored in `users.preferences` (jsonb). Unknown keys and
 * out-of-range values are rejected; the read always returns every key with its
 * default filled in.
 *
 * Feedback (the phone's 「我」 → 发送反馈) lands in the `feedback` table as a request from this
 * member, next to the ones the agent files (Administration → Issues & requests). `context` is
 * what the app knows about itself (version, build, station host, its last recorded error);
 * it is appended to the body as plain lines, never interpreted.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@greenhouse/db';
import { memberPreferencesOf, memberPreferencesPatchSchema } from '@greenhouse/types/preferences';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';

const feedbackSchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    context: z.record(z.string().max(40), z.string().max(500)).optional(),
  })
  .strict();

/** The request's title: the message's first line, cut to fit a list row. */
function feedbackTitle(message: string): string {
  const line =
    message
      .split('\n')
      .find((part) => part.trim())
      ?.trim() ?? message;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

const meRoutes = new Hono<AppEnv>()
  .get('/preferences', async (c) => {
    const user = getAuthUser(c);
    return c.json(memberPreferencesOf(await getDb().users.getPreferences(user.id)));
  })
  .patch('/preferences', async (c) => {
    const user = getAuthUser(c);
    const parsed = memberPreferencesPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        { error: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid preferences' },
        400,
      );
    }
    const patch = parsed.data;
    const saved = await getDb().users.mutatePreferences(user.id, (current) => ({ ...current, ...patch }));
    if (!saved) return c.json({ error: 'User not found' }, 404);
    return c.json(memberPreferencesOf(saved));
  })
  .post('/feedback', async (c) => {
    const user = getAuthUser(c);
    const parsed = feedbackSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'message is required (at most 4000 characters)' }, 400);
    const { message, context } = parsed.data;
    const lines = Object.entries(context ?? {})
      .slice(0, 12)
      .map(([key, value]) => `- ${key}: ${value.replace(/\s+/g, ' ')}`);
    const created = await getDb().featureRequests.create({
      title: feedbackTitle(message),
      description: lines.length ? `${message}\n\n---\n${lines.join('\n')}` : message,
      submitted_by: user.id,
    });
    return c.json({ id: created.id }, 201);
  });

export default meRoutes;
