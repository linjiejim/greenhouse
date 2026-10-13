import { useQuery } from '@tanstack/react-query';
import type { Agent, MemberSummary } from '@greenhouse/contract';
import { api } from '../lib/api';
import { useAgents } from './agents';

/** Names and faces for authors: my Agents and the member directory. */
export function usePeople() {
  const agents = useAgents('mine');
  const members = useQuery({
    queryKey: ['members', 'directory'],
    queryFn: () => api.members.directory(),
    staleTime: 5 * 60_000,
  });
  const agentById = new Map<string, Agent>(agents.items.map((agent) => [agent.id, agent]));
  const memberById = new Map<string, MemberSummary>((members.data?.items ?? []).map((member) => [member.id, member]));
  return { agentById, memberById, agents: agents.items, members: members.data?.items ?? [] };
}
