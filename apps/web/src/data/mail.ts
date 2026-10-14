import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Mailbox, MailItem, UpdateMailboxInput } from '@greenhouse/contract';
import { api } from '../lib/api';
import { keys } from './query';

/** An Agent's mailbox (made on the first look); `available: false` says why there is none. */
export function useMailbox(agentId: string | undefined) {
  return useQuery({
    queryKey: keys.mailbox(agentId ?? ''),
    queryFn: () => api.mail.mailbox(agentId!),
    enabled: !!agentId,
  });
}

export function useMailList(agentId: string, status?: MailItem['status']) {
  const query = useQuery({
    queryKey: keys.mailList(agentId, status),
    queryFn: () => api.mail.list(agentId, status ? { status } : {}),
  });
  return { ...query, items: query.data?.items ?? [] };
}

export function useMailDetail(agentId: string, mailId: string) {
  return useQuery({ queryKey: keys.mail(agentId, mailId), queryFn: () => api.mail.get(agentId, mailId) });
}

/** Changes to a mailbox land in its cache; its lists and counts follow. */
function useMailboxChange<I>(agentId: string, change: (input: I) => Promise<Mailbox>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: change,
    onSuccess: (mailbox) => client.setQueryData(keys.mailbox(agentId), mailbox),
  });
}

export const useUpdateMailbox = (agentId: string) =>
  useMailboxChange(agentId, (input: UpdateMailboxInput) => api.mail.updateMailbox(agentId, input));

export const useAddSender = (agentId: string) =>
  useMailboxChange(agentId, (address: string) => api.mail.addSender(agentId, address));

export const useRemoveSender = (agentId: string) =>
  useMailboxChange(agentId, (address: string) => api.mail.removeSender(agentId, address));

/** Lets a screened mail's sender in; their waiting mail goes into the thread. */
export function useReleaseMail(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (mailId: string) => api.mail.release(agentId, mailId),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.mailAll(agentId) }),
  });
}
