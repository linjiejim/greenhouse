/**
 * Who the app is shared with, and as which role (spec §2 受众, D2 / D3 / D4):
 * people, groups (a group's creator controls who is in it — said next to it)
 * and everyone, each pointing at one role. Saved as a whole list with
 * compare-and-set on `audiencesRevision`.
 *
 * Only the Base owner (or a super) may change it — sharing an app gives
 * people access to the Base's data through it. Everyone else sees the list
 * read-only, with that reason. An entry whose role is not in the published
 * version grants nothing today (D4) and says so.
 *
 * Unlike the draft, sharing is saved by hand ("Save sharing"), so unsaved
 * changes are guarded: the builder asks before another tab replaces this one
 * (`onDirtyChange`), the router before leaving the page, the browser before
 * a reload.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppAudienceEntry, AppAudienceEntryView, AppAudiencesView, AppSpec } from '@greenhouse/types/apps';
import type { ShareableUser, UserGroup } from '@greenhouse/types/api';
import { Button, EmptyState, IconButton, Select, Spinner, Tag, toast } from '../../../components/ui';
import { FormField } from '../../../components/form';
import { PrincipalPicker, type PrincipalSelection } from '../../../components/tables/principal-picker';
import { fetchShareableUsers } from '../../../lib/api';
import { listGroups } from '../../../lib/api/groups';
import { getAppAudiences, isRevisionConflict, setAppAudiences } from '../../../lib/api/apps-builder';
import { useT } from '../../../lib/i18n';
import { Globe, Lock, Plus, Trash2, User, Users } from '../../../lib/icons';
import { registerNavigationGuard } from '../../../lib/navigation-guard';

function principalKey(entry: Pick<AppAudienceEntry, 'principal'>): string {
  const principal = entry.principal;
  if (principal.type === 'user') return `u:${principal.userId}`;
  if (principal.type === 'group') return `g:${principal.groupId}`;
  return 'team';
}

/** Add a picked selection as entries with one role; principals already listed keep their entry. */
export function addAudienceEntries(
  entries: readonly AppAudienceEntryView[],
  selection: PrincipalSelection,
  roleKey: string,
  names: { users: ReadonlyMap<string, ShareableUser>; groups: ReadonlyMap<number, UserGroup> },
): AppAudienceEntryView[] {
  const taken = new Set(entries.map(principalKey));
  const added: AppAudienceEntryView[] = [];
  const push = (entry: AppAudienceEntryView) => {
    const key = principalKey(entry);
    if (taken.has(key)) return;
    taken.add(key);
    added.push(entry);
  };
  if (selection.everyone) push({ principal: { type: 'team' }, roleKey, name: 'everyone' });
  for (const groupId of selection.groupIds) {
    const group = names.groups.get(groupId);
    push({
      principal: { type: 'group', groupId },
      roleKey,
      name: group?.name ?? `#${groupId}`,
      ...(group
        ? {
            managedBy: {
              id: group.created_by,
              name: names.users.get(group.created_by)?.nickname ?? group.created_by,
            },
          }
        : {}),
    });
  }
  for (const userId of selection.userIds) {
    push({ principal: { type: 'user', userId }, roleKey, name: names.users.get(userId)?.nickname ?? userId });
  }
  return [...entries, ...added];
}

export function AudiencesTab({
  appId,
  spec,
  canPublish,
  published,
  onDirtyChange,
}: {
  appId: number;
  /** The draft: its roles may be shared before they are published (they grant nothing until then). */
  spec: AppSpec;
  canPublish: boolean;
  /** A version is live: entries grant access now (else only once the first version is published). */
  published: boolean;
  /** Told when the list has (or no longer has) changes that are not saved yet. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useT();
  const [view, setView] = useState<AppAudiencesView | null>(null);
  const [failed, setFailed] = useState(false);
  const [entries, setEntries] = useState<AppAudienceEntryView[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState<PrincipalSelection>({ userIds: [], groupIds: [] });
  const [pickRole, setPickRole] = useState('');
  const [users, setUsers] = useState<ShareableUser[] | null>(null);
  const [groups, setGroups] = useState<UserGroup[] | null>(null);

  // Unsaved sharing: the builder's tabs ask first; so do the router (it reads the ref inside
  // its `hashchange` listener, before React re-renders) and the browser on a reload.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const reportDirty = useRef(onDirtyChange);
  reportDirty.current = onDirtyChange;
  useEffect(() => {
    reportDirty.current?.(dirty);
  }, [dirty]);
  useEffect(() => {
    const release = registerNavigationGuard(() => dirtyRef.current);
    return () => {
      release();
      reportDirty.current?.(false);
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const next = await getAppAudiences(appId);
      setView(next);
      setEntries(next.entries);
      setDirty(false);
    } catch {
      setFailed(true);
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canPublish) return;
    let cancelled = false;
    void Promise.all([fetchShareableUsers(), listGroups().catch(() => [] as UserGroup[])]).then(([people, teams]) => {
      if (cancelled) return;
      setUsers(people);
      setGroups(teams);
    });
    return () => {
      cancelled = true;
    };
  }, [canPublish]);

  /** Live roles first, then roles only in the draft (marked: they grant nothing until published). */
  const roleOptions = useMemo(() => {
    const live = new Map((view?.roles ?? []).map((role) => [role.key, role.name]));
    const out = [...live].map(([key, name]) => ({ key, name, draftOnly: false }));
    for (const role of spec.roles)
      if (!live.has(role.key)) out.push({ key: role.key, name: role.name, draftOnly: true });
    return out;
  }, [spec.roles, view?.roles]);
  const roleLabel = (key: string) => {
    const role = roleOptions.find((entry) => entry.key === key);
    if (!role) return key;
    return role.draftOnly ? t('apps.builder.audiences.draftRole', { name: role.name }) : role.name;
  };

  useEffect(() => {
    if (!pickRole && roleOptions[0]) setPickRole(roleOptions[0].key);
  }, [pickRole, roleOptions]);

  const save = async () => {
    if (!view) return;
    setSaving(true);
    try {
      const next = await setAppAudiences(
        appId,
        entries.map(({ principal, roleKey }) => ({ principal, roleKey })),
        view.audiencesRevision,
      );
      setView(next);
      setEntries(next.entries);
      setDirty(false);
      toast(t('apps.builder.audiences.saved'), 'success');
    } catch (error) {
      if (isRevisionConflict(error)) {
        toast(t('apps.builder.audiences.conflict'), 'warning');
        await load();
      } else {
        toast(error instanceof Error ? error.message : t('apps.builder.audiences.saveFailed'), 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  if (failed) {
    return (
      <EmptyState
        icon={Users}
        tone="danger"
        title={t('apps.builder.audiences.loadFailed')}
        action={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        }
      />
    );
  }
  if (!view) {
    return (
      <div className="flex justify-center py-10">
        <Spinner className="h-5 w-5 text-fg-faint" />
      </div>
    );
  }

  const names = {
    users: new Map((users ?? []).map((user) => [user.id, user])),
    groups: new Map((groups ?? []).map((group) => [group.id, group])),
  };
  const nothingPicked = picking.userIds.length + picking.groupIds.length === 0 && !picking.everyone;

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="app-audiences-tab">
      <p className="text-xs leading-5 text-fg-muted">{t('apps.builder.audiences.intro')}</p>
      <details className="text-xs text-fg-muted">
        <summary className="cursor-pointer">{t('apps.builder.audiences.priorityTitle')}</summary>
        <p className="mt-2 leading-5">{t('apps.builder.audiences.priority')}</p>
      </details>
      {!canPublish && (
        <p
          className="flex items-start gap-2 rounded-md border border-edge bg-surface-sunken px-3 py-2 text-xs leading-5 text-fg-secondary"
          data-testid="app-audiences-readonly"
        >
          <Lock size={13} className="mt-0.5 flex-shrink-0" />
          {t('apps.builder.audiences.readOnly')}
        </p>
      )}

      {!published && (
        <p className="rounded-md border border-edge bg-surface-sunken px-3 py-2 text-xs text-fg-muted">
          {t('apps.builder.audiences.notPublished')}
        </p>
      )}

      {entries.length === 0 ? (
        <p className="rounded-md border border-dashed border-edge px-3 py-6 text-center text-xs text-fg-faint">
          {t('apps.builder.audiences.empty')}
        </p>
      ) : (
        <ul
          className="divide-y divide-edge rounded-lg border border-edge"
          aria-label={t('apps.builder.audiences.listLabel')}
        >
          {entries.map((entry, index) => {
            const Icon = entry.principal.type === 'team' ? Globe : entry.principal.type === 'group' ? Users : User;
            const name = entry.principal.type === 'team' ? t('apps.builder.audiences.everyone') : entry.name;
            // Saved entries say themselves whether their role is live; new ones are checked against the live roles.
            const live = published && !entry.dangling && (view.roles ?? []).some((role) => role.key === entry.roleKey);
            return (
              <li
                key={principalKey(entry)}
                className="flex flex-wrap items-center gap-2 px-3 py-2"
                data-testid="app-audience-entry"
              >
                <Icon size={14} className="flex-shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg" title={name}>
                    {name}
                  </p>
                  {entry.managedBy && (
                    <p className="truncate text-[11px] text-fg-faint">
                      {t('apps.builder.audiences.managedBy', { name: entry.managedBy.name })}
                    </p>
                  )}
                </div>
                {published && !live && <Tag tone="warning">{t('apps.builder.audiences.notLive')}</Tag>}
                {canPublish ? (
                  <>
                    <Select
                      size="sm"
                      inline
                      aria-label={t('apps.builder.audiences.roleOf', { name })}
                      value={entry.roleKey}
                      onChange={(event) => {
                        setEntries((current) =>
                          current.map((item, at) => (at === index ? { ...item, roleKey: event.target.value } : item)),
                        );
                        setDirty(true);
                      }}
                    >
                      {!roleOptions.some((role) => role.key === entry.roleKey) && (
                        <option value={entry.roleKey}>{entry.roleKey}</option>
                      )}
                      {roleOptions.map((role) => (
                        <option key={role.key} value={role.key}>
                          {roleLabel(role.key)}
                        </option>
                      ))}
                    </Select>
                    <IconButton
                      variant="destructive"
                      label={t('apps.builder.audiences.remove', { name })}
                      onClick={() => {
                        setEntries((current) => current.filter((_, at) => at !== index));
                        setDirty(true);
                      }}
                    >
                      <Trash2 size={12} />
                    </IconButton>
                  </>
                ) : (
                  <Tag tone="neutral">{roleLabel(entry.roleKey)}</Tag>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canPublish && (
        <section className="space-y-3 rounded-lg border border-edge p-3" data-testid="app-audiences-add">
          <h4 className="text-xs font-semibold text-fg-secondary">{t('apps.builder.audiences.addTitle')}</h4>
          {users && groups ? (
            <PrincipalPicker
              value={picking}
              onChange={setPicking}
              allowGroups
              allowEveryone={!entries.some((entry) => entry.principal.type === 'team')}
              users={users}
              groups={groups}
              excludeUserIds={entries.flatMap((entry) =>
                entry.principal.type === 'user' ? [entry.principal.userId] : [],
              )}
              excludeGroupIds={entries.flatMap((entry) =>
                entry.principal.type === 'group' ? [entry.principal.groupId] : [],
              )}
            />
          ) : (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <FormField label={t('apps.builder.audiences.addRole')} className="min-w-[12rem] flex-1">
              <Select value={pickRole} onChange={(event) => setPickRole(event.target.value)}>
                {roleOptions.map((role) => (
                  <option key={role.key} value={role.key}>
                    {roleLabel(role.key)}
                  </option>
                ))}
              </Select>
            </FormField>
            <Button
              variant="outline"
              size="sm"
              disabled={nothingPicked || !pickRole}
              onClick={() => {
                setEntries((current) => addAudienceEntries(current, picking, pickRole, names));
                setPicking({ userIds: [], groupIds: [] });
                setDirty(true);
              }}
              data-testid="app-audiences-add-button"
            >
              <Plus size={13} className="mr-1.5" />
              {t('apps.builder.audiences.add')}
            </Button>
          </div>
        </section>
      )}

      {canPublish && (
        <div className="flex items-center justify-end gap-2">
          {dirty && <span className="text-xs text-fg-faint">{t('apps.builder.audiences.unsaved')}</span>}
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save()} data-testid="app-audiences-save">
            {saving ? t('common.saving') : t('apps.builder.audiences.save')}
          </Button>
        </div>
      )}
    </div>
  );
}
