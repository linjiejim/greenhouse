/**
 * Chat file metadata service.
 *
 * The object-storage backend stays in apps/api; this service owns only the
 * authenticated handle and its session relationship.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { chatFiles } from '../schema/index.js';
import type { ChatFileRow } from '../schema/session.js';

export interface ChatFileInput {
  session_id: string;
  name: string;
  content_type: string;
  size: number;
  storage_key: string;
  source?: ChatFileRow['source'];
  created_by: string;
}

export function createChatFileService(db: Db) {
  return {
    async create(input: ChatFileInput): Promise<ChatFileRow> {
      const [row] = await db
        .insert(chatFiles)
        .values({
          id: randomUUID(),
          ...input,
          created_at: nowIso(),
        })
        .returning();
      return row!;
    },

    async getById(id: string): Promise<ChatFileRow | undefined> {
      const rows = await db.select().from(chatFiles).where(eq(chatFiles.id, id)).limit(1);
      return rows[0];
    },

    async listBySession(sessionId: string): Promise<ChatFileRow[]> {
      return db.select().from(chatFiles).where(eq(chatFiles.session_id, sessionId)).orderBy(asc(chatFiles.created_at));
    },

    /**
     * Resolve ids the MODEL supplied back to rows, scoped to one session.
     * A dispatch card carries file ids chosen by the model, so the session
     * bound is the authorization — never trust the id alone.
     */
    async listBySessionAndIds(sessionId: string, ids: string[]): Promise<ChatFileRow[]> {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(chatFiles)
        .where(and(eq(chatFiles.session_id, sessionId), inArray(chatFiles.id, ids)))
        .orderBy(asc(chatFiles.created_at));
    },

    /** Total bytes a user has uploaded, for the storage quota (D6). */
    async totalUploadedBytes(userId: string): Promise<number> {
      const rows = await db
        .select({ total: sql<string>`coalesce(sum(${chatFiles.size}), 0)` })
        .from(chatFiles)
        .where(and(eq(chatFiles.created_by, userId), eq(chatFiles.source, 'user')));
      return Number(rows[0]?.total ?? 0);
    },
  };
}

export type ChatFileService = ReturnType<typeof createChatFileService>;
