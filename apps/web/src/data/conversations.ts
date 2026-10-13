import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Conversation,
  CreateConversationInput,
  Message,
  SendMessageInput,
  UpdateConversationInput,
} from '@greenhouse/contract';
import { api } from '../lib/api';
import { keys } from './query';
import { addMessage, patchConversation, type ConversationPages } from './realtime';

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
  const messages: Message[] = (query.data?.pages.flatMap((page) => page.items) ?? []).slice().sort((a, b) => a.seq - b.seq);
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
