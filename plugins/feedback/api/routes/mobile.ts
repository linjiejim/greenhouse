/** POST /api/me/feedback — a member's issue or request. */
import { Hono } from 'hono';
import { z } from 'zod';
import { getAuthUser, getDb, type AppEnv } from '@greenhouse/api/extension-kit';
import { feedbackServices } from '../services.js';
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

export const mobileFeedbackRoutes = new Hono<AppEnv>().post('/', async (c) => {
  const user = getAuthUser(c);
  const parsed = feedbackSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'message is required (at most 4000 characters)' }, 400);
  const { message, context } = parsed.data;
  const lines = Object.entries(context ?? {})
    .slice(0, 12)
    .map(([key, value]) => `- ${key}: ${value.replace(/\s+/g, ' ')}`);
  const created = await feedbackServices(getDb()).featureRequests.create({
    title: feedbackTitle(message),
    description: lines.length ? `${message}\n\n---\n${lines.join('\n')}` : message,
    submitted_by: user.id,
  });
  return c.json({ id: created.id }, 201);
});
