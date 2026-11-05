/**
 * /api/ext/example/notes — the example extension's HTTP surface.
 * Mounted by the seam with `requireFeature('example')` as a guard.
 *
 * A note may carry one picture in the plugin's own object store (`pluginObjects`):
 *   POST /notes/:id/picture           → an upload target (presigned PUT, or a ticket URL on local disk)
 *   POST /notes/:id/picture/complete  → verify the stored size, then attach it
 *   POST /notes/:id/picture/describe  → one metered vision call (`analyzeImages`)
 * Listed notes carry a short-lived inline `picture_url`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  analyzeImages,
  findBudgetRefusal,
  getDb,
  getExtensionServices,
  humanActor,
  pluginObjects,
  toErrorMessage,
  type AppEnv,
} from '@greenhouse/api/extension-kit';
import { noteAction } from './service.js';
import type { ExampleServices } from './service.js';

const NoteInput = z.object({ body: z.string().trim().min(1).max(500) });
const PictureInput = z.object({
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  size: z
    .number()
    .int()
    .min(1)
    .max(5 * 1024 * 1024),
});
const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
const objects = pluginObjects('example');
const pictureKey = (id: number) => `notes/${id}/picture`;

function services(): ExampleServices {
  return getExtensionServices<ExampleServices>(getDb(), 'example');
}

function noteId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const exampleRoutes = new Hono<AppEnv>()
  .get('/notes', async (c) => {
    const user = c.get('user');
    const notes = await noteAction(humanActor(user, c), 'read', () => services().notes.list(user.id, 50));
    const pictures = await services().notes.pictureTypes(
      user.id,
      notes.map((note) => note.id),
    );
    const withPictures = await Promise.all(
      notes.map(async (note) => {
        const type = pictures.get(note.id);
        if (!type) return note;
        return {
          ...note,
          picture_url: await objects.readUrl(pictureKey(note.id), { disposition: 'inline', contentType: type }),
        };
      }),
    );
    return c.json({ notes: withPictures });
  })
  .get('/notes/:id', async (c) => {
    const user = c.get('user');
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    const note = await noteAction(humanActor(user, c), 'read', () => services().notes.get(user.id, id));
    return note ? c.json({ note }) : c.json({ error: 'not found' }, 404);
  })
  .post('/notes', async (c) => {
    const user = c.get('user');
    const parsed = NoteInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'body is required (1–500 characters)' }, 400);
    const note = await noteAction(humanActor(user, c), 'create', () => services().notes.add(user.id, parsed.data.body));
    return c.json({ note }, 201);
  })
  .post('/notes/:id/picture', async (c) => {
    const user = c.get('user');
    const id = noteId(c.req.param('id'));
    if (!id) return c.json({ error: 'invalid id' }, 400);
    const parsed = PictureInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'a jpeg, png, webp or gif of at most 5 MB' }, 400);
    // Handing out a write capability is the update itself: authorize it before any storage access.
    const note = await noteAction(humanActor(user, c), 'update', () => services().notes.get(user.id, id));
    if (!note) return c.json({ error: 'not found' }, 404);
    const upload = await objects.uploadUrl({
      key: pictureKey(id),
      contentType: parsed.data.content_type,
      maxBytes: MAX_PICTURE_BYTES,
    });
    return c.json({ upload });
  })
  .post('/notes/:id/picture/complete', async (c) => {
    const user = c.get('user');
    const id = noteId(c.req.param('id'));
    if (!id) return c.json({ error: 'invalid id' }, 400);
    const parsed = PictureInput.pick({ content_type: true }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'content_type is required' }, 400);
    const owned = await noteAction(humanActor(user, c), 'update', () => services().notes.get(user.id, id));
    if (!owned) return c.json({ error: 'not found' }, 404);
    // Trust the store, not the client: a direct upload is not size-capped by the bucket.
    const stored = await objects.head(pictureKey(id));
    if (!stored) return c.json({ error: 'picture not uploaded' }, 400);
    if (stored.size > MAX_PICTURE_BYTES) {
      await objects.delete(pictureKey(id));
      return c.json({ error: 'picture too large' }, 400);
    }
    const note = await noteAction(humanActor(user, c), 'update', () =>
      services().notes.setPicture(user.id, id, parsed.data.content_type),
    );
    if (!note) return c.json({ error: 'not found' }, 404);
    const picture_url = await objects.readUrl(pictureKey(id), {
      disposition: 'inline',
      contentType: parsed.data.content_type,
    });
    return c.json({ note, picture_url });
  })
  .post('/notes/:id/picture/describe', async (c) => {
    const user = c.get('user');
    const id = noteId(c.req.param('id'));
    if (!id) return c.json({ error: 'invalid id' }, 400);
    const note = await noteAction(humanActor(user, c), 'read', () => services().notes.get(user.id, id));
    if (!note) return c.json({ error: 'not found' }, 404);
    const picture = await objects.get(pictureKey(id));
    if (!picture) return c.json({ error: 'this note has no picture' }, 404);
    try {
      const result = await analyzeImages({
        userId: user.id,
        images: [{ bytes: picture.buffer }],
        prompt: 'Describe this picture in one short sentence.',
        maxOutputTokens: 200,
        caller: 'example',
      });
      return c.json({ description: result.text });
    } catch (err) {
      // Over budget is the member's own limit (429); anything else is the vision provider (502).
      const refusal = findBudgetRefusal(err);
      return refusal ? c.json({ error: refusal.message }, 429) : c.json({ error: toErrorMessage(err) }, 502);
    }
  })
  .delete('/notes/:id', async (c) => {
    const user = c.get('user');
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    const removed = await noteAction(humanActor(user, c), 'delete', () => services().notes.remove(user.id, id));
    if (removed) await objects.delete(pictureKey(id));
    return removed ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });
