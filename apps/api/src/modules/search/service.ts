/**
 * `⌘K` search (SRCH-01): conversation titles and message text in the conversations the member is
 * in, the member's own Agents, the people directory (plain ILIKE with the query's wildcards
 * escaped; a few of each kind, newest first where time matters), and the docs they may read
 * (the knowledge base's full-text search, best first).
 */

import { and, asc, desc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import type { SearchItem, SearchKind, SearchResult } from '@greenhouse/contract';
import { agents, conversationMembers, conversations, getDb, messages } from '@greenhouse/db';
import { containing, snippetAround } from '../../http/like.js';
import type { KnowledgeService } from '../knowledge/service.js';
import type { MembersService } from '../members/service.js';

const SNIPPET = 120;

export function createSearchService(deps: { members: MembersService; knowledge: KnowledgeService }) {
  /** Titles to show: a conversation's own, else the name of the Agent it is with. */
  async function agentNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (!wanted.length) return new Map();
    const rows = await getDb()
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, wanted));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  const finders: Record<SearchKind, (memberId: string, q: string, limit: number) => Promise<SearchItem[]>> = {
    async conversations(memberId, q, limit) {
      const rows = await getDb()
        .select({ id: conversations.id, title: conversations.title, agentId: conversations.agentId })
        .from(conversations)
        .innerJoin(
          conversationMembers,
          and(eq(conversationMembers.conversationId, conversations.id), eq(conversationMembers.memberId, memberId)),
        )
        .where(ilike(conversations.title, containing(q)))
        .orderBy(desc(conversations.lastActivityAt), desc(conversations.id))
        .limit(limit);
      return rows.map((row) => ({
        kind: 'conversations',
        id: row.id,
        title: row.title,
        conversation_id: row.id,
        ...(row.agentId ? { agent_id: row.agentId } : {}),
      }));
    },

    async messages(memberId, q, limit) {
      const rows = await getDb()
        .select({
          id: messages.id,
          seq: messages.seq,
          content: messages.content,
          agentId: messages.agentId,
          conversationId: messages.conversationId,
          title: conversations.title,
          conversationAgentId: conversations.agentId,
        })
        .from(messages)
        .innerJoin(
          conversationMembers,
          and(
            eq(conversationMembers.conversationId, messages.conversationId),
            eq(conversationMembers.memberId, memberId),
          ),
        )
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(inArray(messages.role, ['user', 'assistant']), ilike(messages.content, containing(q))))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit);
      const names = await agentNames(rows.map((row) => (row.title ? null : row.conversationAgentId)));
      return rows.map((row) => ({
        kind: 'messages',
        id: row.id,
        title: row.title || names.get(row.conversationAgentId ?? '') || '',
        snippet: snippetAround(row.content, q, SNIPPET),
        conversation_id: row.conversationId,
        seq: row.seq,
        ...(row.agentId ? { agent_id: row.agentId } : {}),
      }));
    },

    async agents(memberId, q, limit) {
      const rows = await getDb()
        .select({ id: agents.id, name: agents.name, role: agents.role })
        .from(agents)
        .where(
          and(
            eq(agents.ownerId, memberId),
            isNull(agents.archivedAt),
            or(ilike(agents.name, containing(q)), ilike(agents.role, containing(q))),
          ),
        )
        .orderBy(desc(agents.isMain), asc(agents.nameKey))
        .limit(limit);
      return rows.map((row) => ({
        kind: 'agents',
        id: row.id,
        title: row.name,
        ...(row.role ? { snippet: row.role } : {}),
        agent_id: row.id,
      }));
    },

    async members(memberId, q, limit) {
      const people = await deps.members.directory(memberId, { q, limit });
      return people.map((person) => ({ kind: 'members', id: person.id, title: person.name, snippet: person.email }));
    },

    async docs(memberId, q, limit) {
      // Nothing when the knowledge base is turned off for the member.
      const found = await deps.knowledge.search(memberId, { q, limit }).catch(() => ({ items: [] }));
      return found.items
        .filter((hit) => hit.type === 'doc')
        .map((hit) => ({
          kind: 'docs',
          id: hit.id,
          title: hit.title,
          ...(hit.snippet ? { snippet: hit.snippet } : {}),
        }));
    },
  };

  return {
    async search(memberId: string, query: { q: string; kinds: SearchKind[]; limit: number }): Promise<SearchResult> {
      const groups = await Promise.all(query.kinds.map((kind) => finders[kind](memberId, query.q, query.limit)));
      return { items: groups.flat() };
    },
  };
}

export type SearchService = ReturnType<typeof createSearchService>;
