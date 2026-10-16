import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateVaultItemInput, UpdateVaultItemInput } from '@greenhouse/contract';
import { api } from '../lib/api';

const VAULT = ['me', 'vault'] as const;

/** My logins for my Agents. Values never come back: only labels, sites and a masked user name. */
export function useVault() {
  return useQuery({ queryKey: [...VAULT, 'items'], queryFn: () => api.me.vault.list({ limit: 200 }) });
}

/** What my Agents did with my logins, newest first; only I can read it. */
export function useVaultLog(enabled: boolean) {
  return useQuery({ queryKey: [...VAULT, 'log'], queryFn: () => api.me.vault.log({ limit: 100 }), enabled });
}

export function useVaultActions() {
  const client = useQueryClient();
  const settle = () => client.invalidateQueries({ queryKey: VAULT });
  return {
    create: useMutation({ mutationFn: (input: CreateVaultItemInput) => api.me.vault.create(input), onSettled: settle }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateVaultItemInput }) => api.me.vault.update(id, input),
      onSettled: settle,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.me.vault.remove(id), onSettled: settle }),
  };
}

export const vaultKey = VAULT;
