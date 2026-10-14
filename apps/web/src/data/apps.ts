import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from './query';
export const appsKeys = {
  all: ['apps'] as const,
  draft: (id: string) => ['apps', id, 'draft'] as const,
  runtime: (id: string, role?: string) => ['apps', id, 'runtime', role ?? ''] as const,
};
export function useApps(enabled = true) {
  const query = useInfiniteQuery({ queryKey: ['apps', 'list'], queryFn: ({ pageParam }) => api.apps.list({ cursor: pageParam, limit: 200 }), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.next_cursor ?? undefined, enabled });
  return { ...query, items: query.data?.pages.flatMap(p => p.items) ?? [] };
}
export const useAppDraft = (id: string) => useQuery({ queryKey: appsKeys.draft(id), queryFn: () => api.apps.draft(id) });
export const useAppRuntime = (id: string, role?: string) => useQuery({ queryKey: appsKeys.runtime(id, role), queryFn: () => api.apps.runtime(id, role) });
export function useAppTemplates() {
  return useInfiniteQuery({ queryKey: ['apps', 'templates'], queryFn: ({ pageParam }) => api.apps.templates.list({ cursor: pageParam, limit: 200 }), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.next_cursor ?? undefined });
}
export const refreshApps = () => queryClient.invalidateQueries({ queryKey: appsKeys.all });
