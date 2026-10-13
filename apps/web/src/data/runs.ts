import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from './query';

export function useRuns(state: 'active' | 'done' | 'all', agent?: string) {
  const query = useQuery({
    queryKey: [...keys.runs(state), agent ?? 'any'],
    queryFn: () => api.runs.list({ state, agent }),
  });
  return { ...query, items: query.data?.items ?? [] };
}

export function useRun(id: string | undefined) {
  return useQuery({ queryKey: keys.run(id ?? ''), queryFn: () => api.runs.get(id!), enabled: !!id });
}

export function useRunAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'cancel' | 'retry' }) =>
      action === 'cancel' ? api.runs.cancel(id) : api.runs.retry(id),
    onSettled: () => client.invalidateQueries({ queryKey: ['runs'] }),
  });
}
