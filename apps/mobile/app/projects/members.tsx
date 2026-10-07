/**
 * Project members — a sheet (param `id`) listing the members (monogram, name,
 * 负责人 / 成员) with a native search bar. Managers (project owner, creator,
 * super — web members-panel `isOwner`) also get:
 *  - an 添加成员 section listing every assignable user who isn't a member yet
 *    (filtered by the same search; tap ⊕ to add),
 *  - a long-press context menu on other members: 设为负责人 / 设为成员 and
 *    移除 (system confirm). The project's owner / creator can't be removed
 *    (the server refuses), so that action is hidden for them.
 * Changes refresh the shared projects store, so the project page updates too;
 * a failed change is a system alert (`alertError`), a success a toast.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { addMember, removeMember, updateMemberRole, type AssignableUser, type ProjectMember } from '../../src/api/projects';
import { useT } from '../../src/lib/i18n';
import { useAuth } from '../../src/store/auth';
import { projectAccess } from '../../src/projects/meta';
import { useAssignableUsers, useProjectDetail } from '../../src/projects/store';
import { space, useTheme } from '../../src/theme';
import { Icon, Spinner } from '../../src/ui/core';
import { InitialAvatar } from '../../src/ui/avatar';
import { alertError, confirmAction } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSection } from '../../src/ui/list';
import { NativeMenu, menuSections, type MenuItem } from '../../src/ui/menu';
import { SheetClose } from '../../src/ui/sheet-chrome';
import { toast } from '../../src/ui/toast';

/** Empty / failed states sit in the middle of the sheet. */
const CENTERED = { flexGrow: 1, justifyContent: 'center' } as const;

export default function MembersSheet() {
  const { colors: c, hex } = useTheme();
  const t = useT();
  const me = useAuth((s) => s.user);
  const params = useLocalSearchParams<{ id: string }>();
  const projectId = Number(params.id);
  const { detail, failed, reload } = useProjectDetail(projectId);
  const users = useAssignableUsers();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const access = detail ? projectAccess(detail.project, detail.members, me) : { canWrite: false, canManage: false };
  const q = query.trim().toLowerCase();
  const match = useCallback((name: string, id: string) => !q || name.toLowerCase().includes(q) || id.toLowerCase().includes(q), [q]);

  const members = useMemo(
    () =>
      (detail?.members ?? [])
        .filter((m) => match(m.nickname ?? m.user_id, m.user_id))
        .sort((a, b) => (a.role === b.role ? 0 : a.role === 'owner' ? -1 : 1)),
    [detail, match],
  );
  const candidates = useMemo(() => {
    const ids = new Set((detail?.members ?? []).map((m) => m.user_id));
    return users.filter((u) => !ids.has(u.id) && match(u.nickname, u.id));
  }, [detail, users, match]);

  const add = useCallback(
    async (u: AssignableUser) => {
      if (busy) return;
      setBusy(u.id);
      const ok = !!(await addMember(projectId, u.id));
      await reload({ fresh: true });
      setBusy(null);
      if (ok) toast(t('projects.memberAdded', { name: u.nickname }), 'userPlus');
      else alertError(t('projects.memberFailed'));
    },
    [busy, projectId, reload, t],
  );

  const onMemberMenu = useCallback(
    async (m: ProjectMember, id: string) => {
      const name = m.nickname ?? m.user_id;
      if (id === 'role') {
        const ok = await updateMemberRole(projectId, m.user_id, m.role === 'owner' ? 'member' : 'owner');
        await reload({ fresh: true });
        if (ok) toast(t('projects.roleUpdated'), 'crown');
        else alertError(t('projects.memberFailed'));
      } else if (id === 'remove') {
        const yes = await confirmAction({
          title: t('projects.removeMember'),
          message: t('projects.removeMemberConfirm', { name }),
          confirmLabel: t('projects.remove'),
          destructive: true,
        });
        if (!yes) return;
        const ok = await removeMember(projectId, m.user_id);
        await reload({ fresh: true });
        if (ok) toast(t('projects.memberRemoved', { name }), 'personMinus');
        else alertError(t('projects.memberFailed'));
      }
    },
    [projectId, reload, t],
  );

  const memberMenu = useCallback(
    (m: ProjectMember): MenuItem[] => {
      if (!access.canManage || !detail || m.user_id === me?.id) return [];
      const fixed = m.user_id === detail.project.owner_id || m.user_id === detail.project.created_by;
      return menuSections([
        [
          m.role === 'owner'
            ? { id: 'role', title: t('projects.setMember'), icon: 'person2' }
            : { id: 'role', title: t('projects.setOwner'), icon: 'crown' },
        ],
        fixed ? [] : [{ id: 'remove', title: t('projects.removeMember'), icon: 'personMinus', destructive: true }],
      ]);
    },
    [access.canManage, detail, me, t],
  );

  return (
    <>
      <Stack.Screen options={{ title: t('projects.members') }} />
      <Stack.SearchBar
        placeholder={t('projects.searchUsers')}
        onChangeText={(e) => setQuery(e.nativeEvent.text)}
        onCancelButtonPress={() => setQuery('')}
        tintColor={hex.accent}
        autoCapitalize="none"
        hideWhenScrolling={false}
      />
      <SheetClose />

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingTop: space.sm, paddingBottom: space.xxxl, flexGrow: 1 }}
      >
        {!detail ? (
          failed ? (
            <EmptyState
              icon="alert"
              title={t('projects.projectMissing')}
              message={t('projects.projectMissingHint')}
              onRetry={() => void reload()}
              style={CENTERED}
            />
          ) : (
            <LoadingState />
          )
        ) : (
          <>
            {members.length > 0 ? (
              <ListSection header={t('projects.memberCount', { n: detail.members.length })}>
                {members.map((m) => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    isMe={m.user_id === me?.id}
                    items={memberMenu(m)}
                    onSelect={(id) => void onMemberMenu(m, id)}
                  />
                ))}
              </ListSection>
            ) : (
              <EmptyState icon="search" title={t('projects.noUserMatch')} />
            )}

            {access.canManage && candidates.length > 0 ? (
              <ListSection header={t('projects.addMember')}>
                {candidates.map((u) => (
                  <ListRow
                    key={u.id}
                    title={u.nickname}
                    leading={<InitialAvatar name={u.nickname} size={32} tint={c.gray} />}
                    accessory={
                      busy === u.id ? (
                        <Spinner />
                      ) : (
                        <Icon name="plusCircle" size={22} color={c.accent} />
                      )
                    }
                    onPress={() => void add(u)}
                    accessibilityLabel={`${t('projects.addMember')} ${u.nickname}`}
                  />
                ))}
              </ListSection>
            ) : null}
          </>
        )}
      </ScrollView>
    </>
  );
}

function MemberRow({
  member,
  isMe,
  items,
  onSelect,
  last,
}: {
  member: ProjectMember;
  isMe: boolean;
  items: MenuItem[];
  onSelect: (id: string) => void;
  /** Injected by ListSection. */
  last?: boolean;
}) {
  const { colors: c } = useTheme();
  const t = useT();
  const name = member.nickname ?? member.user_id;
  const owner = member.role === 'owner';
  const row = (
    <ListRow
      title={isMe ? `${name} ${t('projects.youSuffix')}` : name}
      subtitle={owner ? t('projects.role_owner') : t('projects.role_member')}
      leading={<InitialAvatar name={name} size={32} tint={owner ? c.accent : c.gray} />}
      accessory={owner ? <Icon name="crown" size={15} color={c.orange} /> : 'none'}
      last={last}
    />
  );
  if (items.length === 0) return row;
  return (
    <NativeMenu trigger="longPress" items={items} onSelect={onSelect}>
      {row}
    </NativeMenu>
  );
}
