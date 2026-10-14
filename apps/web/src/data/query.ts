import { QueryClient } from '@tanstack/react-query';
import type { KnowledgeScope, KnowledgeSpace } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // A 4xx will not change on retry; a network failure or a 5xx might.
      retry: (failures, error) => !(error instanceof ApiClientError && error.status < 500) && failures < 2,
    },
    mutations: { retry: false },
  },
});

/** Query keys, one place. Lists start with the same word as their items so one invalidation covers both. */
export const keys = {
  bootstrap: ['bootstrap'] as const,
  me: ['me'] as const,
  myProviders: ['me', 'providers'] as const,
  agents: (scope: 'mine' | 'archived' = 'mine') => ['agents', 'list', scope] as const,
  agent: (id: string) => ['agents', 'one', id] as const,
  computer: (agentId: string) => ['agents', 'computer', agentId] as const,
  computerFiles: (agentId: string) => ['agents', 'files', agentId] as const,
  computerFolder: (agentId: string, path: string) => ['agents', 'files', agentId, path] as const,
  conversations: ['conversations', 'list'] as const,
  conversation: (id: string) => ['conversations', 'one', id] as const,
  messages: (conversationId: string) => ['messages', conversationId] as const,
  members: (conversationId: string) => ['conversations', 'members', conversationId] as const,
  notes: (conversationId: string) => ['notes', conversationId] as const,
  requests: (conversationId?: string) => ['requests', conversationId ?? 'all'] as const,
  runs: (view: string) => ['runs', 'list', view] as const,
  run: (id: string) => ['runs', 'one', id] as const,
  schedules: (agentId?: string) => ['schedules', agentId ?? 'all'] as const,
  notifications: ['notifications', 'list'] as const,
  summary: ['notifications', 'summary'] as const,
  /** Everything the knowledge tree lists: one `knowledge.changed` refetches it all. */
  knowledge: ['knowledge'] as const,
  knowledgeRoots: (scope: KnowledgeScope) => ['knowledge', 'roots', scope] as const,
  knowledgeFolder: (id: string) => ['knowledge', 'folder', id] as const,
  knowledgeRecent: ['knowledge', 'recent'] as const,
  knowledgeTemplates: ['knowledge', 'templates'] as const,
  knowledgeArchived: (space: KnowledgeSpace) => ['knowledge', 'archived', space] as const,
  knowledgeSearch: (q: string, scope?: KnowledgeScope, folderId?: string) =>
    ['knowledge', 'search', q, scope ?? '', folderId ?? ''] as const,
  knowledgeShares: (type: 'folder' | 'doc', id: string) => ['knowledge', 'shares', type, id] as const,
  knowledgeFile: (id: string) => ['knowledge', 'file', id] as const,
  doc: (id: string) => ['docs', 'one', id] as const,
  docVersions: (id: string) => ['docs', 'versions', id] as const,
  docVersion: (id: string, version: number) => ['docs', 'version', id, version] as const,
  docDiff: (id: string, from: number, to: number, mode: 'line' | 'word') =>
    ['docs', 'diff', id, from, to, mode] as const,
  docBacklinks: (id: string) => ['docs', 'backlinks', id] as const,
  docComments: (id: string) => ['docs', 'comments', id] as const,
  docPresence: (id: string) => ['docs', 'presence', id] as const,
};
