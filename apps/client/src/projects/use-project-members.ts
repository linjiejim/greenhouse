/**
 * A project's members panel, shared by the browser dialog (members-dialog.web.tsx) and the phone
 * sheet (app/project-members.tsx): the project with its members, the people who may join (only
 * read for a manager), and add / change role / remove. Every write is bound to the identity that
 * made it, says how it went (toast or alertError) and reloads the list. A refusal (403) makes the
 * panel read-only for the rest of its life; the rules are src/projects/members-model.ts.
 */

import { useCallback, useMemo, useState } from 'react';
import { addMember, getProject, listAssignableUsers, removeMember, setMemberRole } from '../api/projects';
import type { ApiResult } from '../api/client';
import { captureIdentity } from '../data/identity';
import { useResource } from '../data/use-resource';
import { useT, type TranslationKey } from '../lib/i18n';
import type { ProjectMember } from '../shared/greenhouse-types';
import { useAuth } from '../store/auth';
import { alertError, confirmAction } from '../ui/dialogs';
import { toast } from '../ui/toast';
import { addableUsers, canManageMembers, memberControls, sortedMembers, type MemberRole } from './members-model';

const NO_PROJECT = { ok: true as const, data: null };

export function useProjectMembers(projectId: string | null) {
  const t = useT();
  const me = useAuth((s) => s.user);
  const detail = useResource(
    useCallback(() => (projectId ? getProject(projectId) : Promise.resolve(NO_PROJECT)), [projectId]),
    { unfocused: true },
  );
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const project = detail.data?.project ?? null;
  const raw = detail.data?.members;
  const members = useMemo(() => sortedMembers(raw ?? []), [raw]);
  const manage = !refused && canManageMembers(me, project, members);
  const people = useResource(
    useCallback(
      () => (manage ? listAssignableUsers() : Promise.resolve({ ok: true as const, data: { users: [] } })),
      [manage],
    ),
    { unfocused: true },
  );
  const candidates = useMemo(() => addableUsers(people.data?.users ?? [], members), [people.data, members]);
  const { refresh } = detail;

  const write = useCallback(
    async (call: () => Promise<ApiResult<unknown>>, failed: TranslationKey, done: string): Promise<boolean> => {
      if (busy) return false;
      const current = captureIdentity();
      setBusy(true);
      const result = await call();
      if (!current()) return false;
      setBusy(false);
      void refresh();
      if (!result.ok) {
        if (result.status === 403) setRefused(true);
        alertError(t(failed), result.message);
        return false;
      }
      toast(done);
      return true;
    },
    [busy, refresh, t],
  );

  const nameOf = (userId: string) =>
    members.find((m) => m.user_id === userId)?.nickname ??
    people.data?.users.find((u) => u.id === userId)?.nickname ??
    userId;

  const add = (userId: string, role: MemberRole) =>
    projectId
      ? write(() => addMember(projectId, userId, role), 'projects.members.addFailed', t('projects.members.added', { name: nameOf(userId) }))
      : Promise.resolve(false);

  const changeRole = (member: ProjectMember, role: MemberRole) =>
    projectId && role !== member.role
      ? write(() => setMemberRole(projectId, member.user_id, role), 'projects.members.roleFailed', t('projects.members.roleChanged'))
      : Promise.resolve(false);

  const remove = async (member: ProjectMember) => {
    if (!projectId) return false;
    const name = member.nickname ?? member.user_id;
    const current = captureIdentity();
    const sure = await confirmAction({
      title: t('projects.members.removeTitle', { name }),
      message: t('projects.members.removeHint'),
      confirmLabel: t('projects.members.remove'),
      destructive: true,
    });
    if (!sure || !current()) return false;
    return write(() => removeMember(projectId, member.user_id), 'projects.members.removeFailed', t('projects.members.removed', { name }));
  };

  return {
    me,
    project,
    members,
    candidates,
    manage,
    busy,
    loading: detail.loading,
    error: detail.error,
    refresh,
    controls: (member: ProjectMember) => memberControls(member, me, project, manage),
    add,
    changeRole,
    remove,
  };
}

export type ProjectMembers = ReturnType<typeof useProjectMembers>;
