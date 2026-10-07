/**
 * `conversation` — the conversation's shared notes and its searchable past
 * (spec §4.5, §5).
 *
 * Shared notes are the blackboard every Bot in this conversation reads each
 * turn (an index of open notes rides in the turn tail). `recall` searches the
 * messages that are no longer in the Bot's context — summarised away by the
 * digest or left out by the window — and returns sanitized snippets with
 * their message number and date.
 *
 * Background tasks get the read-only half (notes, recall).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import { BotsDomainError } from '@greenhouse/db';
import type { MessageRow } from '@greenhouse/types/session';
import { connectionManager } from '../../ws/connection-manager.js';
import { sanitizeForPrompt } from '../../security/security.js';
import type { BotTurnContext } from '../engine/context.js';
import type { ConversationPort } from '../engine/ports.js';
import { recallMessages } from '../engine/transcript.js';
import { BOT_TOOL_METAS } from './meta.js';

const DESCRIPTION = BOT_TOOL_METAS.find((meta) => meta.id === 'conversation')?.description ?? 'conversation';
const READ_ONLY_DESCRIPTION = `This conversation's shared memory (read-only here).
Actions: notes — list the shared notes; recall {query} — search earlier messages of this conversation (returns snippets with dates).`;

export const NOTE_TITLE_MAX = 80;
export const NOTE_BODY_MAX = 2000;
const RECALL_LIMIT = 8;

const writeSchema = z.object({
  action: z
    .enum(['notes', 'add_note', 'update_note', 'resolve_note', 'recall'])
    .describe('notes | add_note | update_note | resolve_note | recall'),
  id: z.number().int().positive().optional().describe('update_note / resolve_note: the note id (#id in the index).'),
  title: z
    .string()
    .max(NOTE_TITLE_MAX)
    .optional()
    .describe(`add_note / update_note: one line, ≤${NOTE_TITLE_MAX} chars.`),
  body: z.string().max(NOTE_BODY_MAX).optional().describe(`add_note / update_note: details, ≤${NOTE_BODY_MAX} chars.`),
  query: z.string().max(200).optional().describe('recall: keywords (all must appear).'),
});
type WriteInput = z.infer<typeof writeSchema>;

const readSchema = z.object({
  action: z.enum(['notes', 'recall']).describe('notes | recall'),
  query: z.string().max(200).optional().describe('recall: keywords (all must appear).'),
});
type ReadInput = z.infer<typeof readSchema>;

function speakerOf(port: ConversationPort) {
  return (row: MessageRow): string => {
    if (row.role === 'user') return port.nickname;
    if (row.role === 'system') return 'event';
    return port.botName(row.bot_id ?? null) ?? 'Bot';
  };
}

async function listNotes(ctx: BotTurnContext, port: ConversationPort) {
  const notes = await ctx.db.bots.listNotes(ctx.sessionId);
  return {
    action: 'notes',
    notes: notes.slice(0, 60).map((note) => ({
      id: note.id,
      title: note.title,
      body: note.body,
      status: note.status,
      pinned: note.pinned,
      author: note.author_bot_id ? (port.botName(note.author_bot_id) ?? 'Bot') : port.nickname,
      updated_at: note.updated_at,
    })),
  };
}

async function recall(ctx: BotTurnContext, port: ConversationPort, query: string | undefined) {
  const q = query?.trim();
  if (!q) return { action: 'recall', error: 'query is required' };
  const maxSeq = port.recallMaxSeq();
  if (maxSeq < 0) {
    return { action: 'recall', hits: [], note: 'Everything in this conversation is already in your context.' };
  }
  const result = await recallMessages(ctx.db, ctx.sessionId, q, {
    maxSeq,
    limit: RECALL_LIMIT,
    speakerOf: speakerOf(port),
  });
  return {
    action: 'recall',
    // Recalled text is old conversation content — the same trust as any other non-member line.
    hits: result.hits.map((hit) => ({ ...hit, snippet: sanitizeForPrompt(hit.snippet) })),
    ...(result.hits.length === 0
      ? { note: 'No earlier message matches all the keywords. Try fewer or different words.' }
      : {}),
    ...(result.capped ? { note: 'Only the most recent part of the history was searched.' } : {}),
  };
}

function changed(ctx: BotTurnContext): void {
  connectionManager.sendToUser(ctx.userId, { type: 'bots:conversation', sessionId: ctx.sessionId });
}

export function createConversationTool(ctx: BotTurnContext, port: ConversationPort) {
  return tool({
    description: DESCRIPTION,
    inputSchema: writeSchema,
    execute: async (input: WriteInput) => {
      try {
        switch (input.action) {
          case 'notes':
            return await listNotes(ctx, port);
          case 'recall':
            return await recall(ctx, port, input.query);
          case 'add_note': {
            const title = input.title?.trim();
            if (!title) return { action: 'add_note', error: 'title is required' };
            const note = await ctx.db.bots.addNote(ctx.sessionId, {
              title,
              body: input.body?.trim() ?? '',
              author_bot_id: ctx.bot.id,
            });
            changed(ctx);
            return { action: 'add_note', note: { id: note.id, title: note.title } };
          }
          case 'update_note': {
            if (!input.id) return { action: 'update_note', error: 'id is required' };
            if (input.title === undefined && input.body === undefined) {
              return { action: 'update_note', error: 'Nothing to change — pass title and/or body.' };
            }
            const note = await ctx.db.bots.updateNote(ctx.sessionId, input.id, {
              ...(input.title?.trim() ? { title: input.title.trim() } : {}),
              ...(input.body !== undefined ? { body: input.body } : {}),
            });
            if (!note) return { action: 'update_note', error: `No note #${input.id} in this conversation.` };
            changed(ctx);
            return { action: 'update_note', note: { id: note.id, title: note.title, status: note.status } };
          }
          case 'resolve_note': {
            if (!input.id) return { action: 'resolve_note', error: 'id is required' };
            const note = await ctx.db.bots.updateNote(ctx.sessionId, input.id, { status: 'done' });
            if (!note) return { action: 'resolve_note', error: `No note #${input.id} in this conversation.` };
            changed(ctx);
            return { action: 'resolve_note', note: { id: note.id, title: note.title, status: note.status } };
          }
        }
      } catch (error) {
        if (error instanceof BotsDomainError) return { action: input.action, error: error.message };
        return { action: input.action, error: toErrorMessage(error) };
      }
    },
  });
}

/** Background tasks: notes and recall only. */
export function createReadOnlyConversationTool(ctx: BotTurnContext, port: ConversationPort) {
  return tool({
    description: READ_ONLY_DESCRIPTION,
    inputSchema: readSchema,
    execute: async (input: ReadInput) => {
      try {
        return input.action === 'notes' ? await listNotes(ctx, port) : await recall(ctx, port, input.query);
      } catch (error) {
        return { action: input.action, error: toErrorMessage(error) };
      }
    },
  });
}
