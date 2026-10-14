/**
 * The workspace as the drawer and the shell see it (Zustand): my Agents, other members' public
 * Agents shared with me, my conversations (not archived; the first pages), and the bell's one
 * badge (needs-you count and unread). Realtime events patch it (src/realtime/sync.ts); a resync
 * after a reconnect refetches it.
 *
 * Per identity: it empties itself when the member or the station changes, and answers that
 * arrive for a previous identity are dropped (`generation`).
 */

import { create } from 'zustand';
import { listAgents, listPublicAgents } from '../api/agents';
import { listConversations } from '../api/conversations';
import { notificationSummary, type NotificationSummary } from '../api/notifications';
import { patchConversations, upsertConversation } from '../data/directory';
import type { Agent, Conversation, PublicAgent } from '../shared/contract';
import { useAuth } from './auth';
import { useStations } from './stations';

const PAGE = 100;

interface WorkspaceState {
  /** Mine, the main Agent included; null until loaded. */
  agents: Agent[] | null;
  publicAgents: PublicAgent[];
  /** Not archived, newest activity first; null until loaded. */
  conversations: Conversation[] | null;
  /** The next page of conversations (older ones), or null when all are in. */
  next: string | null;
  loadFailed: boolean;
  summary: NotificationSummary | null;
  /** Bumped per identity: answers for an earlier one are dropped. */
  generation: number;
  /** Everything above, at once (startup, pull to refresh, a reconnect). */
  refresh: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  loadMoreConversations: () => Promise<void>;
  refreshSummary: () => Promise<void>;
  patchConversation: (id: string, changes: Partial<Conversation>) => void;
  putConversation: (conversation: Conversation) => void;
  dropConversation: (id: string) => void;
  patchAgent: (agent: Agent) => void;
  reset: () => void;
}

const EMPTY = {
  agents: null,
  publicAgents: [],
  conversations: null,
  next: null,
  loadFailed: false,
  summary: null,
};

export const useWorkspace = create<WorkspaceState>((set, get) => {
  /** Runs `apply` only if no identity change happened since `gen`. */
  const current = (gen: number) => gen === get().generation;

  return {
    ...EMPTY,
    generation: 0,

    async refresh() {
      await Promise.all([get().refreshAgents(), get().refreshConversations(), get().refreshSummary()]);
    },

    async refreshAgents() {
      const gen = get().generation;
      const [mine, shared] = await Promise.all([listAgents('mine'), listPublicAgents()]);
      if (!current(gen)) return;
      if (mine.ok) set({ agents: mine.data.items });
      if (shared.ok) set({ publicAgents: shared.data.items });
    },

    async refreshConversations() {
      const gen = get().generation;
      // As many as were shown: the first page, or more once "earlier" was opened.
      const shown = Math.max(PAGE, Math.min(200, get().conversations?.length ?? 0));
      const page = await listConversations({ limit: shown });
      if (!current(gen)) return;
      if (!page.ok) {
        set({ loadFailed: get().conversations === null });
        return;
      }
      set({ conversations: page.data.items, next: page.data.next_cursor, loadFailed: false });
    },

    async loadMoreConversations() {
      const { next, generation: gen } = get();
      if (!next) return;
      const page = await listConversations({ cursor: next, limit: PAGE });
      if (!current(gen) || !page.ok) return;
      const known = new Set((get().conversations ?? []).map((item) => item.id));
      set({
        conversations: [...(get().conversations ?? []), ...page.data.items.filter((item) => !known.has(item.id))],
        next: page.data.next_cursor,
      });
    },

    async refreshSummary() {
      const gen = get().generation;
      const summary = await notificationSummary();
      if (current(gen) && summary.ok) set({ summary: summary.data });
    },

    patchConversation(id, changes) {
      const list = get().conversations;
      if (!list) return;
      // An archived one leaves the directory (the archived list is fetched on its own).
      if (changes.archived === true) set({ conversations: list.filter((item) => item.id !== id) });
      else set({ conversations: patchConversations(list, id, changes) });
    },

    putConversation(conversation) {
      const list = get().conversations ?? [];
      if (conversation.archived) set({ conversations: list.filter((item) => item.id !== conversation.id) });
      else set({ conversations: upsertConversation(list, conversation) });
    },

    dropConversation(id) {
      const list = get().conversations;
      if (list) set({ conversations: list.filter((item) => item.id !== id) });
    },

    patchAgent(agent) {
      const list = get().agents;
      if (!list) return;
      set({ agents: list.some((item) => item.id === agent.id) ? list.map((item) => (item.id === agent.id ? agent : item)) : [...list, agent] });
    },

    reset() {
      set({ ...EMPTY, generation: get().generation + 1 });
    },
  };
});

/** The main thread's id, once the directory knows it. */
export function mainConversationId(state: Pick<WorkspaceState, 'conversations'>): string | null {
  return state.conversations?.find((item) => item.kind === 'main')?.id ?? null;
}

// Another member or another station: nothing of the previous one survives.
let identity = '';
const follow = () => {
  const next = `${useStations.getState().activeId ?? ''}:${useAuth.getState().user?.id ?? ''}`;
  if (next === identity) return;
  identity = next;
  useWorkspace.getState().reset();
};
useAuth.subscribe(follow);
useStations.subscribe(follow);
