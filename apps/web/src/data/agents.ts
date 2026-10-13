import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateAgentInput, MemoryInput, UpdateAgentInput, UpdateMemoryInput } from '@greenhouse/contract';
import { api } from '../lib/api';
import { keys } from './query';

export function useAgents(scope: 'mine' | 'archived' = 'mine') {
  const query = useQuery({ queryKey: keys.agents(scope), queryFn: () => api.agents.list(scope) });
  return { ...query, items: query.data?.items ?? [] };
}

export function useAgent(id: string | undefined) {
  return useQuery({ queryKey: keys.agent(id ?? ''), queryFn: () => api.agents.get(id!), enabled: !!id });
}

export function useCreateAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentInput) => api.agents.create(input),
    onSuccess: () => client.invalidateQueries({ queryKey: ['agents'] }),
  });
}

export function useUpdateAgent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAgentInput) => api.agents.update(id, input),
    onSuccess: (agent) => {
      client.setQueryData(keys.agent(id), agent);
      void client.invalidateQueries({ queryKey: ['agents', 'list'] });
      void client.invalidateQueries({ queryKey: ['agents', 'versions', id] });
    },
  });
}

export function useArchiveAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.agents.archive(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['agents'] }),
  });
}

export function useRestoreAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.agents.restore(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['agents'] }),
  });
}

export function useVersions(id: string) {
  return useQuery({ queryKey: ['agents', 'versions', id], queryFn: () => api.agents.versions(id) });
}

export function useMemories(id: string) {
  const query = useQuery({ queryKey: ['agents', 'memories', id], queryFn: () => api.agents.memories(id) });
  return { ...query, items: query.data?.items ?? [] };
}

export function useMemoryActions(agentId: string) {
  const client = useQueryClient();
  const settle = () => client.invalidateQueries({ queryKey: ['agents', 'memories', agentId] });
  return {
    remember: useMutation({ mutationFn: (input: MemoryInput) => api.agents.remember(agentId, input), onSettled: settle }),
    edit: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateMemoryInput }) => api.agents.editMemory(agentId, id, input),
      onSettled: settle,
    }),
    forget: useMutation({ mutationFn: (id: string) => api.agents.forget(agentId, id), onSettled: settle }),
  };
}

export function useComputer(agentId: string, enabled = true) {
  return useQuery({
    queryKey: keys.computer(agentId),
    queryFn: () => api.agents.computer(agentId),
    enabled,
    refetchInterval: (query) => (query.state.data?.state === 'starting' ? 2_000 : false),
  });
}

export function useProcesses(agentId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['agents', 'processes', agentId],
    queryFn: () => api.agents.processes(agentId),
    enabled,
    refetchInterval: 10_000,
  });
}

export function useComputerAction(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: 'start' | 'stop' | 'restart') =>
      action === 'start'
        ? api.agents.startComputer(agentId)
        : action === 'stop'
          ? api.agents.stopComputer(agentId)
          : api.agents.restartComputer(agentId),
    onSuccess: (view) => client.setQueryData(keys.computer(agentId), view),
    onSettled: () => client.invalidateQueries({ queryKey: ['agents', 'processes', agentId] }),
  });
}

/** A folder of the computer's home ('' is the home itself). */
export function useComputerFiles(agentId: string, path: string, enabled = true) {
  return useQuery({
    queryKey: keys.computerFolder(agentId, path),
    queryFn: () => api.agents.files(agentId, path),
    enabled,
  });
}

export function useComputerFileActions(agentId: string) {
  const client = useQueryClient();
  const settle = () => client.invalidateQueries({ queryKey: keys.computerFiles(agentId) });
  return {
    upload: useMutation({
      mutationFn: ({ folder, file }: { folder: string; file: File }) => api.agents.uploadFile(agentId, folder, file),
      onSettled: settle,
    }),
    remove: useMutation({ mutationFn: (path: string) => api.agents.removeFile(agentId, path), onSettled: settle }),
  };
}

/** The models I may pick for an Agent; the picker shows only when there is a choice. */
export function useModelChoices() {
  return useQuery({ queryKey: ['me', 'models'], queryFn: () => api.me.models(), staleTime: 60_000 });
}
