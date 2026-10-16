import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateScheduleInput, UpdateScheduleInput } from '@greenhouse/contract';
import { api } from '../lib/api';
import { keys } from './query';

export function useSchedules(agentId?: string) {
  const query = useQuery({ queryKey: keys.schedules(agentId), queryFn: () => api.schedules.list(agentId) });
  return { ...query, items: query.data?.items ?? [] };
}

export function useScheduleActions() {
  const client = useQueryClient();
  const settle = () => client.invalidateQueries({ queryKey: ['schedules'] });
  return {
    create: useMutation({ mutationFn: (input: CreateScheduleInput) => api.schedules.create(input), onSettled: settle }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateScheduleInput }) => api.schedules.update(id, input),
      onSettled: settle,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.schedules.remove(id), onSettled: settle }),
    pause: useMutation({ mutationFn: (id: string) => api.schedules.pause(id), onSettled: settle }),
    resume: useMutation({ mutationFn: (id: string) => api.schedules.resume(id), onSettled: settle }),
    runNow: useMutation({
      mutationFn: (id: string) => api.schedules.runNow(id),
      onSettled: () => {
        void settle();
        void client.invalidateQueries({ queryKey: ['runs'] });
      },
    }),
  };
}
