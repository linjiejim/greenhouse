/**
 * Memory tool — the only way a memory gets written.
 *
 * The system prompt carries an index of one-line titles; this tool opens the
 * bodies (`recall`), writes new notes (`remember`), corrects them (`update`) and
 * retires them (`forget`). There is no background extraction: if the model
 * doesn't call this, nothing is remembered.
 *
 * Owner-scoped by construction — every action resolves through the requesting
 * user's id, so a model can never read or touch another person's memories, super
 * included. Lazy and not session-scoped: memories belong to a user, not to a
 * conversation, so scheduled runs and subagents reach it too.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider, UserMemoryRow } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';
import { validateMemoryText, MEMORY_TITLE_MAX, MEMORY_CONTENT_MAX } from '../llm/memory-limits.js';

const memorySchema = z.object({
  action: z
    .enum(['remember', 'recall', 'update', 'forget'])
    .describe('remember: store a new memory. recall: read full memories. update: correct one. forget: retire one.'),
  title: z
    .string()
    .optional()
    .describe(
      `One-line recall index (≤${MEMORY_TITLE_MAX} chars). Write it so a future reader can judge relevance WITHOUT opening the note: "Prefers CRM figures broken down by 客户类型, not by country" beats "CRM preferences".`,
    ),
  content: z
    .string()
    .optional()
    .describe(
      `The memory itself (≤${MEMORY_CONTENT_MAX} chars). One self-contained idea, specific enough to still be usable in a month.`,
    ),
  category: z
    .enum(['preference', 'fact', 'behavior'])
    .optional()
    .describe(
      'preference: how they want answers (style, language, format). fact: who they are (role, projects, stack, domain). behavior: how they work (workflows, habits, conventions).',
    ),
  pinned: z.boolean().optional().describe('Pinned memories never go dormant and sort first. Use sparingly.'),
  ids: z.number().int().array().optional().describe('Memory ids to open — for recall.'),
  query: z.string().optional().describe('Keyword search over titles and bodies — for recall.'),
  include_inactive: z
    .boolean()
    .optional()
    .describe('Include dormant/archived memories in a recall search (default false).'),
  id: z.number().int().optional().describe('Memory id — required for update and forget.'),
});

type MemoryInput = z.infer<typeof memorySchema>;

export interface MemoryToolContext {
  userId: string;
  sessionId?: string;
}

const meta: ToolMeta = {
  id: 'memory',
  name: 'Memory',
  brief: 'Remember durable facts about this user, and read back what you already know',
  description: `Your long-term memory of THIS user with THIS coworker, carried across conversations with the same coworker. Memories of other coworkers are private. The system prompt lists what you already know, one title per line; this tool opens those notes and writes new ones.

Call \`remember\` whenever the user tells you to ("remember that…", "from now on…") — that is never optional — and when you learn something durable about them or about how they want to be worked with. Do NOT store one-off task details, anything you can look up on demand, or credentials (those are rejected). Prefer \`update\` over storing a second, contradicting note.

Write memories in ENGLISH whatever language you are speaking, with one exception that matters: keep literals EXACTLY as they appear — identifiers, enum values (e.g. 潜在), document titles, customer names, error strings. A translated literal stops matching the thing it names, which makes the memory worse than useless.`,
  category: 'core',
  // Rides the `memory` feature flag (default-on) rather than being global, so a
  // super who explicitly disables memory for someone also removes the tool.
  is_global: false,
  builtin: true,
  icon: 'Brain',
  runtime_risk: 'r1',
  // Deliberately no `surface`: this tool mixes reads and writes, so it fits
  // neither proxy tier — declaring it 'read' would let a stateless caller write
  // memories with no confirm gate. Chat, scheduled tasks and spawned subagents
  // all reach it as a lazy tool; /api/agent and /api/mcp do not.
  sort_order: 37,
};

function publicShape(row: UserMemoryRow) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.content,
    status: row.status,
    pinned: row.pinned,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

export function createMemoryTool(db: DatabaseProvider, ctx: MemoryToolContext) {
  return tool({
    description: meta.description,
    inputSchema: memorySchema,
    execute: async (input: MemoryInput) => {
      try {
        const agentId = await db.coworkers.memoryScopeForSession(ctx.sessionId);
        switch (input.action) {
          case 'remember': {
            if (!input.title || !input.content) {
              return { action: input.action, error: 'title and content are required for remember' };
            }
            const check = validateMemoryText({ title: input.title, content: input.content });
            if (!check.ok) return { action: input.action, error: check.error };

            const row = await db.userMemories.create({
              user_id: ctx.userId,
              agent_instance_id: agentId,
              category: input.category ?? 'fact',
              title: input.title.trim(),
              content: input.content.trim(),
              pinned: input.pinned,
              source: 'agent',
              source_session_id: ctx.sessionId,
            });
            return { action: input.action, remembered: publicShape(row) };
          }

          case 'recall': {
            let rows: UserMemoryRow[] = [];
            if (input.ids && input.ids.length > 0) {
              const found = await Promise.all(input.ids.map((id) => db.userMemories.getOwned(id, ctx.userId, agentId)));
              rows = found.filter((r): r is UserMemoryRow => Boolean(r));
            } else if (input.query) {
              rows = await db.userMemories.search(ctx.userId, input.query, {
                includeInactive: input.include_inactive,
                agentId,
              });
            } else {
              return { action: input.action, error: 'recall needs either ids or query' };
            }

            // Reading is the one signal that a memory still earns its place.
            if (rows.length > 0)
              await db.userMemories.touch(
                rows.map((r) => r.id),
                ctx.userId,
              );
            return { action: input.action, count: rows.length, memories: rows.map(publicShape) };
          }

          case 'update': {
            if (input.id === undefined) return { action: input.action, error: 'id is required for update' };
            const existing = await db.userMemories.getOwned(input.id, ctx.userId, agentId);
            if (!existing) return { action: input.action, error: `memory ${input.id} not found` };

            const check = validateMemoryText({ title: input.title, content: input.content });
            if (!check.ok) return { action: input.action, error: check.error };

            const updated = await db.userMemories.update(input.id, ctx.userId, {
              title: input.title?.trim(),
              content: input.content?.trim(),
              category: input.category,
              pinned: input.pinned,
            });
            await db.userMemories.touch([input.id], ctx.userId);
            return { action: input.action, updated: updated ? publicShape(updated) : undefined };
          }

          case 'forget': {
            if (input.id === undefined) return { action: input.action, error: 'id is required for forget' };
            const existing = await db.userMemories.getOwned(input.id, ctx.userId, agentId);
            if (!existing) return { action: input.action, error: `memory ${input.id} not found` };

            await db.userMemories.setStatus(input.id, ctx.userId, 'archived');
            return { action: input.action, forgotten: input.id, note: 'Archived — the user can restore it.' };
          }
        }
      } catch (error) {
        return { action: input.action, error: toErrorMessage(error) };
      }
    },
  });
}

export const memoryTool = defineTool({ meta, kind: 'lazy' });
