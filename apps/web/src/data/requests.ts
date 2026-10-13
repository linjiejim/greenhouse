import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from './query';

/** What needs the member, everywhere or in one conversation. */
export function useRequests(conversationId?: string, state: 'pending' | 'all' = 'all', enabled = true) {
  const query = useQuery({
    queryKey: [...keys.requests(conversationId), state],
    queryFn: () => api.requests.list({ state, conversation_id: conversationId }),
    enabled,
  });
  return { ...query, items: query.data?.items ?? [] };
}

export function useDecide() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (
      input:
        | { id: string; action: 'approve' }
        | { id: string; action: 'reject'; reason?: string }
        | { id: string; action: 'answer'; answers: Record<string, string> }
        | { id: string; action: 'handback'; note?: string },
    ) =>
      input.action === 'approve'
        ? api.requests.approve(input.id)
        : input.action === 'reject'
          ? api.requests.reject(input.id, input.reason)
          : input.action === 'answer'
            ? api.requests.answer(input.id, input.answers)
            : api.requests.handback(input.id, input.note),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['requests'] });
      void client.invalidateQueries({ queryKey: keys.summary });
    },
  });
}
