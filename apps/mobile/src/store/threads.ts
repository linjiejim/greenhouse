/**
 * Transcripts of the conversations opened in this run (Zustand): their messages (oldest first),
 * the cursor to older pages, their 「需要你」 cards (all states, so decided ones read as decided),
 * and for rooms the people in them (read receipts, @ mentions).
 *
 * Opening a conversation loads its newest page; opening it again, or a realtime resync, catches
 * up from the last sequence number (`after`). Realtime events merge messages by id
 * (../data/thread.ts) — the text of a reply being written is not here but in ../data/streams.ts.
 *
 * Per identity: emptied when the member or the station changes; answers for an earlier one are
 * dropped (`generation`).
 */

import { create } from 'zustand';
import { conversationMembers, getConversation, listMessages } from '../api/conversations';
import { listRequests } from '../api/requests';
import { lastSeq, mergeMessages, mergeRequests, patchMessage, removeMessages } from '../data/thread';
import type { ConversationDetail, ConversationMembers, Message, MessageItem, NeedsYou } from '../shared/contract';
import { clearStreams } from '../data/streams';
import { useAuth } from './auth';
import { useStations } from './stations';

const PAGE = 50;

export interface ThreadEntry {
  messages: MessageItem[];
  /** Cursor of the next older page; null once the oldest message is in. */
  older: string | null;
  status: 'loading' | 'ready' | 'error';
  loadingOlder: boolean;
  requests: NeedsYou[];
  /** Rooms: who is in it (names, faces, how far each has read). */
  members: ConversationMembers | null;
  /** Its people, Agents and digest (the long-conversation summary). */
  detail: ConversationDetail | null;
}

const EMPTY_ENTRY: ThreadEntry = {
  messages: [],
  older: null,
  status: 'loading',
  loadingOlder: false,
  requests: [],
  members: null,
  detail: null,
};

interface ThreadsState {
  threads: Record<string, ThreadEntry>;
  generation: number;
  /** Load the newest page (first time), or catch up from the last message (again). */
  open: (id: string) => Promise<void>;
  loadOlder: (id: string) => Promise<void>;
  /** Messages after the last one known (a resync after a reconnect). */
  catchUp: (id: string) => Promise<void>;
  refreshRequests: (id: string) => Promise<void>;
  refreshMembers: (id: string) => Promise<void>;
  refreshDetail: (id: string) => Promise<void>;
  addMessages: (id: string, messages: readonly (Message | MessageItem)[]) => void;
  dropMessages: (id: string, messageIds: readonly string[]) => void;
  patchMessage: (id: string, messageId: string, changes: Partial<MessageItem>) => void;
  putRequests: (id: string, requests: readonly NeedsYou[]) => void;
  patchMembers: (id: string, memberId: string, lastReadSeq: number) => void;
  reset: () => void;
}

export const useThreads = create<ThreadsState>((set, get) => {
  const entry = (id: string) => get().threads[id] ?? EMPTY_ENTRY;
  const update = (id: string, change: (current: ThreadEntry) => Partial<ThreadEntry>) =>
    set((state) => {
      const current = state.threads[id] ?? EMPTY_ENTRY;
      return { threads: { ...state.threads, [id]: { ...current, ...change(current) } } };
    });
  const current = (gen: number) => gen === get().generation;

  return {
    threads: {},
    generation: 0,

    async open(id) {
      const known = get().threads[id];
      if (known && known.status === 'ready') {
        await Promise.all([get().catchUp(id), get().refreshRequests(id)]);
        return;
      }
      const gen = get().generation;
      update(id, () => ({ status: 'loading' }));
      const [page] = await Promise.all([
        listMessages(id, { limit: PAGE }),
        get().refreshRequests(id),
        get().refreshDetail(id),
      ]);
      if (!current(gen)) return;
      if (!page.ok) {
        update(id, (thread) => ({ status: thread.messages.length ? 'ready' : 'error' }));
        return;
      }
      update(id, (thread) => ({
        messages: mergeMessages(thread.messages, page.data.items),
        older: page.data.next_cursor,
        status: 'ready',
      }));
    },

    async loadOlder(id) {
      const thread = entry(id);
      if (!thread.older || thread.loadingOlder) return;
      const gen = get().generation;
      update(id, () => ({ loadingOlder: true }));
      const page = await listMessages(id, { cursor: thread.older, limit: PAGE });
      if (!current(gen)) return;
      update(id, (now) =>
        page.ok
          ? { messages: mergeMessages(now.messages, page.data.items), older: page.data.next_cursor, loadingOlder: false }
          : { loadingOlder: false },
      );
    },

    async catchUp(id) {
      const thread = get().threads[id];
      if (!thread || thread.status !== 'ready') return;
      const gen = get().generation;
      let after = lastSeq(thread.messages);
      // A busy conversation can have more than a page since: keep reading until it is in.
      for (let pages = 0; pages < 10; pages += 1) {
        const page = await listMessages(id, { after, limit: 200 });
        if (!current(gen) || !page.ok) return;
        // Replies that were still being written come back with their saved text: refresh them too.
        const streaming = get().threads[id]?.messages.filter((m) => m.status === 'streaming').map((m) => m.id) ?? [];
        update(id, (now) => ({ messages: mergeMessages(now.messages, page.data.items) }));
        if (streaming.length) void refreshStreaming(id, streaming);
        if (!page.data.next_cursor || !page.data.items.length) return;
        after = Math.max(after, ...page.data.items.map((m) => m.seq));
      }
    },

    async refreshRequests(id) {
      const gen = get().generation;
      const page = await listRequests({ state: 'all', conversation_id: id, limit: 200 });
      if (!current(gen) || !page.ok) return;
      update(id, (thread) => ({ requests: mergeRequests([], [...thread.requests.filter((r) => r.status !== 'pending'), ...page.data.items]) }));
    },

    async refreshMembers(id) {
      const gen = get().generation;
      const members = await conversationMembers(id);
      if (current(gen) && members.ok) update(id, () => ({ members: members.data }));
    },

    async refreshDetail(id) {
      const gen = get().generation;
      const detail = await getConversation(id);
      if (current(gen) && detail.ok) update(id, () => ({ detail: detail.data }));
    },

    addMessages(id, messages) {
      if (!get().threads[id]) return;
      update(id, (thread) => ({ messages: mergeMessages(thread.messages, messages) }));
    },

    dropMessages(id, messageIds) {
      if (!get().threads[id]) return;
      update(id, (thread) => ({ messages: removeMessages(thread.messages, messageIds) }));
    },

    patchMessage(id, messageId, changes) {
      if (!get().threads[id]) return;
      update(id, (thread) => ({ messages: patchMessage(thread.messages, messageId, changes) }));
    },

    putRequests(id, requests) {
      if (!get().threads[id]) return;
      update(id, (thread) => ({ requests: mergeRequests(thread.requests, requests) }));
    },

    patchMembers(id, memberId, lastReadSeq) {
      const members = get().threads[id]?.members;
      if (!members) return;
      update(id, () => ({
        members: {
          ...members,
          members: members.members.map((person) =>
            person.id === memberId ? { ...person, last_read_seq: Math.max(person.last_read_seq, lastReadSeq) } : person,
          ),
        },
      }));
    },

    reset() {
      clearStreams();
      set({ threads: {}, generation: get().generation + 1 });
    },
  };
});

/**
 * Replies that were being written when the socket dropped: the catch-up page only has newer
 * messages, so read these again by their sequence numbers (one page just before the first).
 */
async function refreshStreaming(id: string, messageIds: readonly string[]): Promise<void> {
  const thread = useThreads.getState().threads[id];
  if (!thread) return;
  const seqs = thread.messages.filter((m) => messageIds.includes(m.id)).map((m) => m.seq);
  if (!seqs.length) return;
  const gen = useThreads.getState().generation;
  const page = await listMessages(id, { after: Math.min(...seqs) - 1, limit: 200 });
  if (gen !== useThreads.getState().generation || !page.ok) return;
  useThreads.getState().addMessages(id, page.data.items);
}

// Another member or another station: nothing of the previous one survives.
let identity = '';
const follow = () => {
  const next = `${useStations.getState().activeId ?? ''}:${useAuth.getState().user?.id ?? ''}`;
  if (next === identity) return;
  identity = next;
  useThreads.getState().reset();
};
useAuth.subscribe(follow);
useStations.subscribe(follow);
