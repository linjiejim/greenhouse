/**
 * `example_notes_query` — a lazy tool (it needs the calling user), built through
 * the generic `createLazy` path every extension tool can use.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { getExtensionServices } from '@greenhouse/db';
import { entityUrl } from '@greenhouse/types/entity-links';
import { defineTool } from '../../tools/define.js';
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
    surface: { proxy: 'read', mcp: 'example', workbench: true, unattendedReplaySafe: true },
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
