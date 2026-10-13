import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/** External access (SET-08, ADM-09): my tokens and grants, and the admin's clients. */
export const accessKeys = {
  tokens: ['access', 'tokens'] as const,
  grants: ['access', 'grants'] as const,
  clients: ['admin', 'clients'] as const,
};

/** At most 20 live tokens per member: one page holds them all. */
export function usePersonalTokens() {
  return useQuery({ queryKey: accessKeys.tokens, queryFn: () => api.me.tokens.list({ limit: 200 }) });
}

export function useGrants() {
  return useQuery({ queryKey: accessKeys.grants, queryFn: () => api.me.grants.list({ limit: 200 }) });
}

export function useClients() {
  return useInfiniteQuery({
    queryKey: accessKeys.clients,
    queryFn: ({ pageParam }) => api.admin.clients.list({ cursor: pageParam, limit: 100 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}
