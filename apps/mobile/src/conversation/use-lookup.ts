/**
 * Who is who in a conversation: Agents (mine, the public ones shared with me, and in a room the
 * ones others brought) and people (me, and in a room everyone in it), by id.
 */

import { useMemo } from 'react';
import type { Agent, ConversationMembers, Me, PublicAgent } from '../shared/contract';
import type { AgentFace } from '../ui/agent-avatar';

export interface AgentInfo extends AgentFace {
  name: string;
  role: string;
  is_main: boolean;
  owner_id: string;
}

export interface PersonInfo {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface Lookup {
  agent(id: string | null | undefined): AgentInfo | undefined;
  person(id: string | null | undefined): PersonInfo | undefined;
}

export function useLookup({
  me,
  agents,
  publicAgents,
  members,
}: {
  me: Me | null;
  agents: readonly Agent[] | null;
  publicAgents: readonly PublicAgent[];
  members: ConversationMembers | null | undefined;
}): Lookup {
  return useMemo(() => {
    const agentMap = new Map<string, AgentInfo>();
    for (const agent of members?.agents ?? []) {
      agentMap.set(agent.id, {
        id: agent.id,
        avatar: agent.avatar,
        template_key: null,
        name: agent.name,
        role: agent.role,
        is_main: false,
        owner_id: agent.owner_id,
      });
    }
    for (const agent of [...publicAgents, ...(agents ?? [])]) {
      agentMap.set(agent.id, {
        id: agent.id,
        avatar: agent.avatar,
        template_key: agent.template_key,
        name: agent.name,
        role: agent.role,
        is_main: agent.is_main,
        owner_id: agent.owner_id,
      });
    }
    const people = new Map<string, PersonInfo>();
    for (const person of members?.members ?? []) {
      people.set(person.id, { id: person.id, name: person.name, avatarUrl: person.avatar_url });
    }
    if (me) people.set(me.id, { id: me.id, name: me.name, avatarUrl: me.avatar_url });
    return {
      agent: (id) => (id ? agentMap.get(id) : undefined),
      person: (id) => (id ? people.get(id) : undefined),
    };
  }, [me, agents, publicAgents, members]);
}
