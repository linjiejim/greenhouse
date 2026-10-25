/**
 * `example_notes_query` — a lazy tool (it needs the calling user), built through
 * the generic `createLazy` path every extension tool can use.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { entityUrl } from '@greenhouse/types/entity-links';
import { defineTool, getExtensionServices } from '../../extension-kit.js';
import type { ExampleServices } from './service.js';

export const exampleNotesQueryTool = defineTool({
  meta: {
    id: 'example_notes_query',
    name: 'Example notes',
    brief: 'List the notes the current user saved in the Example extension',
    description:
      'Return the notes the current user saved in the Example extension, newest first. ' +
      'Use it when the user asks what they noted down; it never modifies anything.',
    category: 'team',
    is_global: false,
    icon: 'StickyNote',
    sort_order: 900,
    surface: { proxy: 'read', mcp: 'example', unattendedReplaySafe: true },
  },
  kind: 'lazy',
  createLazy: ({ db, userId }) =>
    tool({
      description: 'List the current user’s example notes, newest first.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(10).describe('How many notes to return'),
      }),
      execute: async ({ limit }) => {
        const { notes } = getExtensionServices<ExampleServices>(db, 'example');
        const rows = await notes.list(userId, limit);
        return {
          count: rows.length,
          // `url` is the in-app deeplink for the record kind this extension
          // registered, so the chat renders a peek instead of a raw link.
          notes: rows.map((r) => ({
            id: r.id,
            body: r.body,
            created_at: r.created_at,
            url: entityUrl({ kind: 'ext:example:note', id: r.id }),
          })),
        };
      },
    }),
});

/**
 * `example_notes_mutation` — the reference WRITE tool. Declaring
 * `surface.proxy: 'write'` is what puts it under governed writes when a
 * member's own agent calls it over `/api/mcp`: the call runs as the member, is
 * recorded as an `agent_write` run, and a delete-like action (`notes.delete`)
 * first returns a preview and only runs again with `confirm: true`.
 * A tool that changes data must never declare `proxy: 'read'`.
 */
export const exampleNotesMutationTool = defineTool({
  meta: {
    id: 'example_notes_mutation',
    name: 'Example notes (write)',
    brief: 'Add or delete a note in the Example extension',
    description:
      'Add a note for the current user (`notes.add` with `body`) or delete one of their notes ' +
      '(`notes.delete` with `id`). Deleting is permanent.',
    category: 'team',
    is_global: false,
    icon: 'StickyNote',
    sort_order: 901,
    surface: { proxy: 'write', mcp: 'example' },
  },
  kind: 'lazy',
  createLazy: ({ db, userId }) =>
    tool({
      description: 'Add a note (notes.add + body) or delete one (notes.delete + id) for the current user.',
      inputSchema: z.object({
        action: z.enum(['notes.add', 'notes.delete']).describe('What to do'),
        body: z.string().trim().min(1).max(500).optional().describe('Note text, for notes.add'),
        id: z.number().int().positive().optional().describe('Note id, for notes.delete'),
      }),
      execute: async ({ action, body, id }) => {
        const { notes } = getExtensionServices<ExampleServices>(db, 'example');
        if (action === 'notes.add') {
          if (!body) return { ok: false, error: 'body is required for notes.add' };
          const note = await notes.add(userId, body);
          return { ok: true, note: { id: note.id, body: note.body } };
        }
        if (id === undefined) return { ok: false, error: 'id is required for notes.delete' };
        return { ok: await notes.remove(userId, id), id };
      },
    }),
});
