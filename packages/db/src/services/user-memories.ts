/**
 * User memory service — persistent user-specific memory from conversations (PostgreSQL).
 *
 * Includes simple keyword-overlap deduplication:
 * same user + same category + >60% keyword overlap → update existing.
 */

import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { userMemories } from '../schema/index.js';
import type { UserMemoryRow } from '../schema/user-memory.js';

export interface UserMemoryInput {
  user_id: string;
  category: string;
  content: string;
  source_session_id?: string;
  confidence?: number;
}

export interface UserMemoryUpdateInput {
  category?: string;
  content?: string;
  confidence?: number;
}

/** Max memories per user — oldest/lowest-confidence are pruned. */
const MAX_MEMORIES_PER_USER = 50;

/** Tokenise content for overlap comparison. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

/** Calculate Jaccard-like overlap ratio between two token sets. */
function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const smaller = Math.min(a.size, b.size);
  return intersection / smaller;
}

export function createUserMemoryService(db: Db) {
  const service = {
    /** Add a memory (deduplicates by keyword overlap within same user+category). */
    async upsert(input: UserMemoryInput): Promise<UserMemoryRow> {
      const now = nowIso();
      const newTokens = tokenize(input.content);

      // Find existing memories in same user + category
      const existing = await db
        .select()
        .from(userMemories)
        .where(and(eq(userMemories.user_id, input.user_id), eq(userMemories.category, input.category)));

      // Check for similar content (keyword overlap > 60%)
      for (const mem of existing) {
        const existingTokens = tokenize(mem.content);
        if (overlapRatio(newTokens, existingTokens) > 0.6) {
          // Update existing memory with new content
          const rows = await db
            .update(userMemories)
            .set({
              content: input.content,
              source_session_id: input.source_session_id ?? mem.source_session_id,
              confidence: input.confidence ?? mem.confidence,
              updated_at: now,
            })
            .where(eq(userMemories.id, mem.id))
            .returning();
          return rows[0];
        }
      }

      // Insert new memory
      const rows = await db
        .insert(userMemories)
        .values({
          user_id: input.user_id,
          category: input.category,
          content: input.content,
          source_session_id: input.source_session_id ?? null,
          confidence: input.confidence ?? 0.8,
          access_count: 0,
          created_at: now,
          updated_at: now,
        })
        .returning();

      // Prune if over limit
      await service.pruneIfNeeded(input.user_id);

      return rows[0];
    },

    /** Batch add memories. Returns count of upserted rows. */
    async upsertBatch(inputs: UserMemoryInput[]): Promise<number> {
      let count = 0;
      for (const input of inputs) {
        await service.upsert(input);
        count++;
      }
      return count;
    },

    /** Get user's memories sorted by confidence desc, updated_at desc. */
    async listByUser(userId: string, limit = 50): Promise<UserMemoryRow[]> {
      return await db
        .select()
        .from(userMemories)
        .where(eq(userMemories.user_id, userId))
        .orderBy(desc(userMemories.confidence), desc(userMemories.updated_at))
        .limit(limit);
    },

    /** Get memories by category. */
    async listByCategory(userId: string, category: string): Promise<UserMemoryRow[]> {
      return await db
        .select()
        .from(userMemories)
        .where(and(eq(userMemories.user_id, userId), eq(userMemories.category, category)))
        .orderBy(desc(userMemories.confidence), desc(userMemories.updated_at));
    },

    /** Record access (update access_count and last_accessed_at). */
    async touchMany(ids: number[]): Promise<void> {
      if (ids.length === 0) return;
      const now = nowIso();
      await db
        .update(userMemories)
        .set({
          access_count: sql`${userMemories.access_count} + 1`,
          last_accessed_at: now,
        })
        .where(inArray(userMemories.id, ids));
    },

    /** Update a memory. */
    async update(id: number, updates: UserMemoryUpdateInput): Promise<UserMemoryRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.category !== undefined) set.category = updates.category;
      if (updates.content !== undefined) set.content = updates.content;
      if (updates.confidence !== undefined) set.confidence = updates.confidence;

      const rows = await db.update(userMemories).set(set).where(eq(userMemories.id, id)).returning();
      return rows[0];
    },

    /** Delete a single memory. */
    async delete(id: number): Promise<boolean> {
      const rows = await db.delete(userMemories).where(eq(userMemories.id, id)).returning();
      return rows.length > 0;
    },

    /** Delete all memories for a user. */
    async deleteAllForUser(userId: string): Promise<void> {
      await db.delete(userMemories).where(eq(userMemories.user_id, userId));
    },

    /** Count memories for a user. */
    async countByUser(userId: string): Promise<number> {
      const rows = await db
        .select({ count: sql<string>`count(*)` })
        .from(userMemories)
        .where(eq(userMemories.user_id, userId));
      return Number(rows[0]?.count ?? 0);
    },

    /** Remove lowest-confidence, least-accessed memories if user exceeds limit. */
    async pruneIfNeeded(userId: string): Promise<void> {
      const count = await service.countByUser(userId);
      if (count <= MAX_MEMORIES_PER_USER) return;

      const excess = count - MAX_MEMORIES_PER_USER;
      // Find the IDs to prune: lowest confidence, oldest last_accessed
      const toPrune = await db
        .select({ id: userMemories.id })
        .from(userMemories)
        .where(eq(userMemories.user_id, userId))
        .orderBy(userMemories.confidence, userMemories.last_accessed_at)
        .limit(excess);

      if (toPrune.length > 0) {
        await db.delete(userMemories).where(
          inArray(
            userMemories.id,
            toPrune.map((r) => r.id),
          ),
        );
      }
    },
  };
  return service;
}

export type UserMemoryService = ReturnType<typeof createUserMemoryService>;
