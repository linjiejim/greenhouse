import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useStandingApprovals(agentId: string) {
  const query = useInfiniteQuery({
    queryKey: ['standing-approvals', agentId], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.agents.standingApprovals(agentId, pageParam),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  return { ...query, items: query.data?.pages.flatMap((page) => page.items) ?? [] };
}
export function useRevokeStandingApproval(agentId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.agents.revokeStandingApproval(agentId, id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['standing-approvals', agentId] }),
  });
}
