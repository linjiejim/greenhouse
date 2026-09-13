/**
 * User prompt service — user quick prompt (slash command) CRUD (PostgreSQL).
 */

import { and, eq, ne, or, asc, desc } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import * as schema from '../schema/index.js';
import type { UserPromptRow } from '../schema/user-prompt.js';

export interface UserPromptInput {
  user_id: string;
  title: string;
  content: string;
  shortcut?: string;
  sort_order?: number;
  is_global?: boolean;
  description?: string | null;
  /** JSON-serialized `TaskVariable[]`; callers validate before storing. */
  variables?: string;
  /** JSON-serialized `string[]` of tool ids. */
  expected_tools?: string;
  source_session_id?: string | null;
  artifact_action_id?: string | null;
  created_via?: 'manual' | 'capture';
}

export interface UserPromptUpdateInput {
  title?: string;
  content?: string;
  shortcut?: string | null;
  sort_order?: number;
  is_global?: boolean;
  description?: string | null;
  variables?: string;
  expected_tools?: string;
}

export function createUserPromptService(db: Db) {
  const service = {
    async create(input: UserPromptInput): Promise<UserPromptRow> {
      const now = nowIso();
      const [row] = await db
        .insert(schema.userPrompts)
        .values({
          user_id: input.user_id,
          title: input.title,
          content: input.content,
          shortcut: input.shortcut ?? null,
          sort_order: input.sort_order ?? 0,
          is_global: input.is_global ?? false,
          description: input.description ?? null,
          variables: input.variables ?? '[]',
          expected_tools: input.expected_tools ?? '[]',
          source_session_id: input.source_session_id ?? null,
          artifact_action_id: input.artifact_action_id ?? null,
          created_via: input.created_via ?? 'manual',
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row;
    },

    async getById(id: number): Promise<UserPromptRow | undefined> {
      const [row] = await db.select().from(schema.userPrompts).where(eq(schema.userPrompts.id, id)).limit(1);
      return row;
    },

    async getByArtifactActionId(actionId: string): Promise<UserPromptRow | undefined> {
      const [row] = await db
        .select()
        .from(schema.userPrompts)
        .where(eq(schema.userPrompts.artifact_action_id, actionId))
        .limit(1);
      return row;
    },

    /** List user's own prompts + all global prompts. */
    async listForUser(userId: string): Promise<UserPromptRow[]> {
      return db
        .select()
        .from(schema.userPrompts)
        .where(or(eq(schema.userPrompts.user_id, userId), eq(schema.userPrompts.is_global, true)))
        .orderBy(asc(schema.userPrompts.sort_order), desc(schema.userPrompts.created_at));
    },

    /** Mutually-exclusive ownership scopes for the Tasks workspace. */
    async listForScope(userId: string, scope: 'mine' | 'shared' | 'team'): Promise<UserPromptRow[]> {
      const where =
        scope === 'mine'
          ? eq(schema.userPrompts.user_id, userId)
          : scope === 'shared'
            ? and(eq(schema.userPrompts.is_global, true), ne(schema.userPrompts.user_id, userId))
            : and(eq(schema.userPrompts.is_global, false), ne(schema.userPrompts.user_id, userId));
      return db
        .select()
        .from(schema.userPrompts)
        .where(where)
        .orderBy(asc(schema.userPrompts.sort_order), desc(schema.userPrompts.created_at));
    },

    async update(id: number, updates: UserPromptUpdateInput): Promise<UserPromptRow | undefined> {
      const values: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.title !== undefined) values.title = updates.title;
      if (updates.content !== undefined) values.content = updates.content;
      if (updates.shortcut !== undefined) values.shortcut = updates.shortcut;
      if (updates.sort_order !== undefined) values.sort_order = updates.sort_order;
      if (updates.is_global !== undefined) values.is_global = updates.is_global;
      if (updates.description !== undefined) values.description = updates.description;
      if (updates.variables !== undefined) values.variables = updates.variables;
      if (updates.expected_tools !== undefined) values.expected_tools = updates.expected_tools;

      const [row] = await db.update(schema.userPrompts).set(values).where(eq(schema.userPrompts.id, id)).returning();
      return row;
    },

    async delete(id: number): Promise<boolean> {
      const result = await db
        .delete(schema.userPrompts)
        .where(eq(schema.userPrompts.id, id))
        .returning({ id: schema.userPrompts.id });
      return result.length > 0;
    },
  };
  return service;
}

export type UserPromptService = ReturnType<typeof createUserPromptService>;
