import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from './query';

/** The notification badge counts only effective unread pointers. */
export function useNotificationSummary() {
  return useQuery({ queryKey: keys.summary, queryFn: api.notifications.summary, refetchInterval: 120_000 });
}

export function useNotifications(unread = false) {
  const query = useInfiniteQuery({
    queryKey: [...keys.notifications, unread ? 'unread' : 'all'],
    queryFn: ({ pageParam }) => api.notifications.list({ unread, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  return { ...query, items: query.data?.pages.flatMap((page) => page.items) ?? [] };
}

export function useMarkNotificationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { ids: string[] } | { all: true }) => api.notifications.read(input),
    onSettled: () => client.invalidateQueries({ queryKey: ['notifications'] }),
  });
}
