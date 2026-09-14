/**
 * /api/ext/example/notes — the example extension's HTTP surface.
 * Mounted by the seam with `requireFeature('example')` as a guard.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, getExtensionServices } from '@greenhouse/db';
import type { AppEnv } from '../../app-env.js';
import type { ExampleServices } from './service.js';

const NoteInput = z.object({ body: z.string().trim().min(1).max(500) });

function services(): ExampleServices {
  return getExtensionServices<ExampleServices>(getDb(), 'example');
}

export const exampleRoutes = new Hono<AppEnv>()
  .get('/notes', async (c) => {
    const user = c.get('user');
    const notes = await services().notes.list(user.id, 50);
    return c.json({ notes });
  })
  .post('/notes', async (c) => {
    const user = c.get('user');
    const parsed = NoteInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'body is required (1–500 characters)' }, 400);
    const note = await services().notes.add(user.id, parsed.data.body);
    return c.json({ note }, 201);
  })
  .delete('/notes/:id', async (c) => {
    const user = c.get('user');
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    const removed = await services().notes.remove(user.id, id);
    return removed ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });
