/**
 * Chat file metadata service — the conversation-owned rows of `files`
 * (`source` = `chat_upload` for something the person uploaded, `chat_output`
 * for a tool's output).
 *
 * The object-storage backend stays in apps/api; this service owns only the
 * authenticated handle and its session relationship. The facade keeps its 1.x
 * row shape (`ChatFileRow`, `source: 'agent' | 'user'`): a private extension
 * reads it.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { files } from '../schema/index.js';
import type { FileRow } from '../schema/files.js';

/** A chat file as callers see it. */
export interface ChatFileRow {
  id: string;
  session_id: string;
  name: string;
  content_type: string;
  size: number;
  storage_key: string;
  /** `agent` = tool output, `user` = the person uploaded it. */
  source: 'agent' | 'user';
  created_by: string;
  created_at: string;
}

export interface ChatFileInput {
  session_id: string;
  name: string;
  content_type: string;
  size: number;
  storage_key: string;
  /** Defaults to `agent` (tool output). */
  source?: ChatFileRow['source'];
  created_by: string;
}

const CHAT_SOURCES = ['chat_upload', 'chat_output'] as const;

function toChatFile(row: FileRow): ChatFileRow {
  return {
    id: row.id,
    session_id: row.session_id ?? '',
    name: row.name,
    content_type: row.content_type ?? 'application/octet-stream',
    size: row.size,
    storage_key: row.storage_key ?? '',
    source: row.source === 'chat_upload' ? 'user' : 'agent',
    created_by: row.created_by ?? '',
    created_at: row.created_at,
  };
}

const isChatFile = inArray(files.source, [...CHAT_SOURCES]);

export function createChatFileService(db: Db) {
  return {
    async create(input: ChatFileInput): Promise<ChatFileRow> {
      const now = nowIso();
      const [row] = await db
        .insert(files)
        .values({
          id: newId('file'),
          source: input.source === 'user' ? 'chat_upload' : 'chat_output',
          session_id: input.session_id,
          name: input.name,
          content_type: input.content_type,
          size: input.size,
          storage_key: input.storage_key,
          status: 'active',
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return toChatFile(row!);
    },

    async getById(id: string): Promise<ChatFileRow | undefined> {
      const rows = await db
        .select()
        .from(files)
        .where(and(eq(files.id, id), isChatFile))
        .limit(1);
      return rows[0] ? toChatFile(rows[0]) : undefined;
    },

    async listBySession(sessionId: string): Promise<ChatFileRow[]> {
      const rows = await db
        .select()
        .from(files)
        .where(and(eq(files.session_id, sessionId), isChatFile))
        .orderBy(asc(files.created_at), asc(files.id));
      return rows.map(toChatFile);
    },

    /**
     * Resolve ids the MODEL supplied back to rows, scoped to one session.
     * A dispatch card carries file ids chosen by the model, so the session
     * bound is the authorization — never trust the id alone.
     */
    async listBySessionAndIds(sessionId: string, ids: string[]): Promise<ChatFileRow[]> {
      if (ids.length === 0) return [];
      const rows = await db
        .select()
        .from(files)
        .where(and(eq(files.session_id, sessionId), isChatFile, inArray(files.id, ids)))
        .orderBy(asc(files.created_at), asc(files.id));
      return rows.map(toChatFile);
    },

    /** Total bytes a user has uploaded into conversations, for the storage quota (D6). */
    async totalUploadedBytes(userId: string): Promise<number> {
      const rows = await db
        .select({ total: sql<string>`coalesce(sum(${files.size}), 0)` })
        .from(files)
        .where(and(eq(files.created_by, userId), eq(files.source, 'chat_upload')));
      return Number(rows[0]?.total ?? 0);
    },
  };
}

export type ChatFileService = ReturnType<typeof createChatFileService>;
