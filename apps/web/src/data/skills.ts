import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateSkillInput,
  NewSkillVersionInput,
  SkillScanDecisionInput,
  UpdateSkillInput,
} from '@greenhouse/contract';
import { api } from '../lib/api';
import type { SkillScope } from '../lib/router';

const SKILLS = ['skills'] as const;

/** The list query for a directory scope. */
export function scopeQuery(scope: SkillScope, q?: string): Parameters<typeof api.skills.list>[0] {
  const base = q ? { q } : {};
  switch (scope) {
    case 'team':
      return { ...base, space: 'team' };
    case 'mine':
      return { ...base, space: 'personal' };
    case 'review':
      return { ...base, scan_status: 'suspicious' };
    case 'archived':
      return { ...base, archived: true };
    default:
      return base;
  }
}

/** Skills I can see; `agent` decides `available` (the `/` menu passes the answering Agent). */
export function useSkills(query: Parameters<typeof api.skills.list>[0] = {}, enabled = true) {
  const result = useQuery({
    queryKey: [...SKILLS, 'list', query],
    queryFn: () => api.skills.list({ limit: 200, ...query }),
    enabled,
    staleTime: 60_000,
  });
  return { ...result, items: result.data?.items ?? [] };
}

export function useSkill(id: string) {
  return useQuery({ queryKey: [...SKILLS, 'one', id], queryFn: () => api.skills.get(id) });
}

export function useSkillVersions(id: string) {
  return useQuery({ queryKey: [...SKILLS, 'versions', id], queryFn: () => api.skills.versions(id) });
}

/** A new chat's empty state: my most-used skills for this Agent, else its template's starters. */
export function useSkillStarters(agent: string | undefined) {
  return useQuery({
    queryKey: [...SKILLS, 'starters', agent ?? 'main'],
    queryFn: () => api.skills.starters(agent),
    staleTime: 60_000,
  });
}

export function useSkillActions() {
  const client = useQueryClient();
  const settle = () => client.invalidateQueries({ queryKey: SKILLS });
  return {
    create: useMutation({ mutationFn: (input: CreateSkillInput) => api.skills.create(input), onSettled: settle }),
    upload: useMutation({
      mutationFn: ({ zip, space }: { zip: File; space: 'team' | 'personal' }) => api.skills.upload(zip, { space }),
      onSettled: settle,
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateSkillInput }) => api.skills.update(id, input),
      onSettled: settle,
    }),
    addVersion: useMutation({
      mutationFn: ({ id, input }: { id: string; input: NewSkillVersionInput }) => api.skills.addVersion(id, input),
      onSettled: settle,
    }),
    archive: useMutation({ mutationFn: (id: string) => api.skills.archive(id), onSettled: settle }),
    restore: useMutation({ mutationFn: (id: string) => api.skills.restore(id), onSettled: settle }),
    scan: useMutation({
      mutationFn: ({ id, input }: { id: string; input: SkillScanDecisionInput }) => api.skills.scan(id, input),
      onSettled: settle,
    }),
  };
}
