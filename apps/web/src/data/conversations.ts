import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddMembersInput,
  Conversation,
  CreateConversationInput,
  CreateNoteInput,
  MessageItem,
  SendMessageInput,
  UpdateConversationInput,
  UpdateNoteInput,
} from '@greenhouse/contract';
import { api } from '../lib/api';
import { keys } from './query';
import { addMessage, patchConversation, patchMessage, type ConversationPages } from './realtime';

const PAGE = 100;

/** Every conversation the member is in, newest activity first (the module column). */
export function useConversations() {
  const query = useInfiniteQuery({
    queryKey: keys.conversations,
    queryFn: ({ pageParam }) => api.conversations.list({ cursor: pageParam, limit: PAGE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return { ...query, items };
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: keys.conversation(id ?? ''),
    queryFn: () => api.conversations.get(id!),
    enabled: !!id,
  });
}

/** Messages newest first, a page at a time; the page shows them oldest first. */
export function useMessages(conversationId: string | undefined) {
  const query = useInfiniteQuery({
    queryKey: keys.messages(conversationId ?? ''),
    queryFn: ({ pageParam }) => api.conversations.messages(conversationId!, { cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: !!conversationId,
    staleTime: Infinity,
  });
  const messages: MessageItem[] = (query.data?.pages.flatMap((page) => page.items) ?? [])
    .slice()
    .sort((a, b) => a.seq - b.seq);
  return { ...query, messages };
}

export function useSendMessage(conversationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SendMessageInput) => api.conversations.send(conversationId, input),
    onSuccess: (result) => addMessage(client, result.message),
  });
}

export function useStop(conversationId: string) {
  return useMutation({ mutationFn: () => api.conversations.stop(conversationId) });
}

export function useCreateConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateConversationInput) => api.conversations.create(input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.conversations }),
  });
}

/** Pin, rename, mute or archive: shown at once, then confirmed by the server. */
export function useUpdateConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateConversationInput }) => api.conversations.update(id, input),
    onMutate: async ({ id, input }) => {
      await client.cancelQueries({ queryKey: keys.conversations });
      const before = client.getQueryData<ConversationPages>(keys.conversations);
      patchConversation(client, id, input as Partial<Conversation>);
      return { before };
    },
    onError: (_error, _variables, context) => {
      if (context?.before) client.setQueryData(keys.conversations, context.before);
    },
    onSettled: () => client.invalidateQueries({ queryKey: keys.conversations }),
  });
}

export function useDeleteConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.conversations.remove(id),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.conversations }),
  });
}

/** Marks everything up to `seq` read, once per new seq. */
export function useMarkRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, seq }: { id: string; seq: number }) => api.conversations.read(id, seq),
    onMutate: ({ id, seq }) => patchConversation(client, id, { last_read_seq: seq, unread: 0 }),
  });
}

/** 👍 / 👎, shown at once. */
export function useRate(conversationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, rating }: { messageId: string; rating: 1 | -1 | 0 }) =>
      api.conversations.rate(conversationId, messageId, { rating }),
    onMutate: ({ messageId, rating }) =>
      patchMessage(client, conversationId, messageId, { my_rating: rating === 0 ? null : rating }),
    onError: () => client.invalidateQueries({ queryKey: keys.messages(conversationId) }),
  });
}

/** My last message, new text; the replies after it go and it is answered again. */
export function useEditMessage(conversationId: string) {
  return useMutation({
    mutationFn: ({ messageId, content }: { messageId: string; content: string }) =>
      api.conversations.edit(conversationId, messageId, content),
  });
}

export function useRegenerate(conversationId: string) {
  return useMutation({
    mutationFn: (messageId: string) => api.conversations.regenerate(conversationId, messageId),
  });
}

export function useConversationMembers(conversationId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.members(conversationId ?? ''),
    queryFn: () => api.conversations.members(conversationId!),
    enabled: enabled && !!conversationId,
  });
}

export function useMemberActions(conversationId: string) {
  const client = useQueryClient();
  const settle = () => {
    void client.invalidateQueries({ queryKey: keys.members(conversationId) });
    void client.invalidateQueries({ queryKey: keys.conversation(conversationId) });
  };
  return {
    add: useMutation({
      mutationFn: (input: AddMembersInput) => api.conversations.addMembers(conversationId, input),
      onSuccess: (members) => client.setQueryData(keys.members(conversationId), members),
      onSettled: settle,
    }),
    remove: useMutation({
      mutationFn: (memberId: string) => api.conversations.removeMember(conversationId, memberId),
      onSettled: () => {
        settle();
        void client.invalidateQueries({ queryKey: keys.conversations });
      },
    }),
  };
}

export function useNotes(conversationId: string) {
  const query = useQuery({
    queryKey: keys.notes(conversationId),
    queryFn: () => api.conversations.notes(conversationId, { limit: 100 }),
  });
  return { ...query, items: query.data?.items ?? [] };
}

export function useNoteActions(conversationId: string) {
  const client = useQueryClient();
  const settle = () => client.invalidateQueries({ queryKey: keys.notes(conversationId) });
  return {
    add: useMutation({ mutationFn: (input: CreateNoteInput) => api.conversations.addNote(conversationId, input), onSettled: settle }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateNoteInput }) =>
        api.conversations.updateNote(conversationId, id, input),
      onSettled: settle,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.conversations.removeNote(conversationId, id), onSettled: settle }),
  };
}

/** Saves the conversation as a Markdown file in the browser. */
export async function downloadConversation(id: string) {
  const { filename, markdown } = await api.conversations.export(id);
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
