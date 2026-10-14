/**
 * A base's own panels: sharing (owners; members, groups or everyone in built-in or custom roles, saved
 * together), the recycle bin (restore, or delete for good), the audit log and renaming.
 */

import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Building2, Trash2, Undo2, Users } from 'lucide-react';
import {
  Badge,
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  IconButton,
  Overlay,
  OverlayActions,
  Select,
  Skeleton,
  type SelectOption,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import {
  BASE_ROLES,
  GROUP_SHARE_ROLES,
  roleAtLeast,
  type Base,
  type BaseRole,
  type BaseShare,
  type TrashItem,
} from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { useSession } from '../../app/session';
import { usePeople } from '../../data/people';
import { refreshBase, tablesKeys } from '../../data/tables';
import { queryClient } from '../../data/query';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { relativeTime } from '../../lib/time';
import { MemberAvatar } from '../../shell/MemberAvatar';
import { tablesError } from './errors';
import { useDraftNavigation } from './useDraftNavigation';
import { NameDialog } from './TableTabs';

type Entry = Pick<BaseShare, 'type' | 'id' | 'name' | 'role' | 'custom_role_id'>;
const keyOf = (entry: Pick<Entry, 'type' | 'id'>) => `${entry.type}:${entry.id ?? ''}`;

export function ShareDialog({ base, onClose }: { base: Base; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const { members, memberById } = usePeople();
  const shares = useQuery({ queryKey: tablesKeys.shares(base.id), queryFn: () => api.tables.bases.shares(base.id) });
  const groups = useQuery({
    queryKey: ['groups', 'directory'],
    queryFn: () => api.members.groups(),
    staleTime: 60_000,
  });
  const [items, setItems] = useState<Entry[] | null>(null);
  const [adding, setAdding] = useState('');
  const [role, setRole] = useState('viewer');
  const roles = useQuery({ queryKey: tablesKeys.roles(base.id), queryFn: () => api.tables.bases.roles(base.id) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigation = useDraftNavigation(items !== null, busy, onClose);
  const current = items ?? shares.data?.items ?? [];
  const taken = new Set(current.map(keyOf));
  const roleOptions = (type: Entry['type']): SelectOption[] => [
    ...(type === 'member' ? BASE_ROLES : GROUP_SHARE_ROLES).map((value) => ({
      value,
      label: t(`tables.share.role.${value}`),
      description: t(`tables.share.hint.${value}`),
    })),
    ...(roles.data?.items ?? []).map((entry) => ({
      value: entry.id,
      label: entry.name,
      description: entry.description,
    })),
  ];
  const candidates: SelectOption[] = [
    ...(taken.has('workspace:') ? [] : [{ value: 'workspace:', label: t('tables.share.everyone') }]),
    ...(groups.data?.items ?? [])
      .filter((group) => !taken.has(`group:${group.id}`))
      .map((group) => ({ value: `group:${group.id}`, label: group.name, description: t('tables.share.group') })),
    ...members
      .filter((member) => member.id !== shares.data?.owner.id && !taken.has(`member:${member.id}`))
      .map((member) => ({
        value: `member:${member.id}`,
        label: member.name,
        description: member.email,
        icon: <MemberAvatar name={member.name} url={member.avatar_url} size={18} />,
      })),
  ];
  const add = () => {
    if (!adding) return;
    const [type, id] = adding.split(':') as [Entry['type'], string];
    const name =
      type === 'workspace'
        ? ''
        : type === 'group'
          ? (groups.data?.items.find((group) => group.id === id)?.name ?? '')
          : (memberById.get(id)?.name ?? '');
    const custom = roles.data?.items.some((entry) => entry.id === role);
    const allowed = custom || type === 'member' || (GROUP_SHARE_ROLES as readonly string[]).includes(role);
    setItems([
      ...current,
      {
        type,
        id: type === 'workspace' ? null : id,
        name,
        role: custom ? 'custom' : allowed ? (role as BaseRole) : 'viewer',
        custom_role_id: custom ? role : null,
      },
    ]);
    setAdding('');
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api.tables.bases.share(base.id, {
        items: current.map((entry) => ({
          type: entry.type,
          ...(entry.id ? { id: entry.id } : {}),
          role: entry.role,
          ...(entry.role === 'custom' && entry.custom_role_id ? { custom_role_id: entry.custom_role_id } : {}),
        })),
      });
      queryClient.setQueryData(tablesKeys.shares(base.id), saved);
      void refreshBase(base.id);
      notify(t('tables.share.saved'));
      onClose();
    } catch (failure) {
      setError(tablesError(failure, t));
      setBusy(false);
    }
  };
  const nameOf = (entry: Entry) => (entry.type === 'workspace' ? t('tables.share.everyone') : entry.name);
  return (
    <Overlay
      variant="dialog"
      wide
      title={t('tables.share.title', { name: base.name })}
      onClose={onClose}
      beforeClose={() => {
        if (busy) return false;
        if (!items) return true;
        navigation.ask();
        return false;
      }}
    >
      {shares.isPending || roles.isPending ? (
        <Skeleton lines={3} />
      ) : shares.isError || roles.isError ? (
        <ErrorBox onRetry={() => void Promise.all([shares.refetch(), roles.refetch()])}>
          {tablesError(shares.error ?? roles.error, t)}
        </ErrorBox>
      ) : (
        <div className="app-tb-share">
          <div className="app-tb-share-add">
            <Select
              label={t('tables.share.add')}
              placeholder={t('tables.share.add')}
              value={adding}
              options={candidates}
              onChange={setAdding}
            />
            <Select
              label={t('tables.share.role')}
              value={role}
              options={roleOptions(adding.startsWith('member:') || !adding ? 'member' : 'group')}
              onChange={(next) => setRole(next as BaseRole)}
            />
            <Button onClick={add} disabled={!adding}>
              {t('tables.share.addButton')}
            </Button>
          </div>
          <p className="app-muted app-tb-note">{t('tables.share.groupRoles')}</p>
          <ul className="app-tb-share-list">
            <li>
              <MemberAvatar
                name={shares.data.owner.name}
                url={memberById.get(shares.data.owner.id)?.avatar_url}
                size={28}
              />
              <span className="app-tb-share-name">{shares.data.owner.name}</span>
              <Badge>{t('tables.share.owner')}</Badge>
            </li>
            {current.map((entry) => (
              <li key={keyOf(entry)}>
                {entry.type === 'member' ? (
                  <MemberAvatar name={entry.name} url={memberById.get(entry.id ?? '')?.avatar_url} size={28} />
                ) : (
                  <span className="app-tb-share-icon" aria-hidden>
                    {entry.type === 'group' ? <Users size={icon.md} /> : <Building2 size={icon.md} />}
                  </span>
                )}
                <span className="app-tb-share-name">{nameOf(entry)}</span>
                <Select
                  label={t('tables.share.roleOf', { name: nameOf(entry) })}
                  size="sm"
                  value={entry.custom_role_id ?? entry.role}
                  options={roleOptions(entry.type)}
                  onChange={(next) =>
                    setItems(
                      current.map((item) =>
                        keyOf(item) === keyOf(entry)
                          ? {
                              ...item,
                              role: roles.data?.items.some((entry) => entry.id === next)
                                ? 'custom'
                                : (next as BaseRole),
                              custom_role_id: roles.data?.items.some((entry) => entry.id === next) ? next : null,
                            }
                          : item,
                      ),
                    )
                  }
                />
                <IconButton
                  size="sm"
                  label={t('tables.share.remove', { name: nameOf(entry) })}
                  onClick={() => setItems(current.filter((item) => keyOf(item) !== keyOf(entry)))}
                >
                  <Trash2 size={icon.sm} strokeWidth={icon.stroke} />
                </IconButton>
              </li>
            ))}
          </ul>
          {!current.length && <p className="app-muted">{t('tables.share.onlyYou')}</p>}
          {error && (
            <p className="app-form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      <OverlayActions>
        <Button
          disabled={busy}
          onClick={() => {
            if (items) navigation.ask();
            else onClose();
          }}
        >
          {t('common.cancel')}
        </Button>
        <Button kind="primary" loading={busy} disabled={!items} onClick={() => void save()}>
          {t('tables.share.save')}
        </Button>
      </OverlayActions>
      {navigation.asking && (
        <ConfirmDialog
          danger
          title={t('tables.record.discardTitle')}
          confirmLabel={t('tables.record.discard')}
          onCancel={navigation.cancel}
          onConfirm={navigation.discard}
        >
          {t('tables.record.discardBody')}
        </ConfirmDialog>
      )}
    </Overlay>
  );
}

export function TrashDrawer({ base, onClose }: { base: Base; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const notify = useNotify();
  const trash = useInfiniteQuery({
    queryKey: tablesKeys.trash(base.id),
    queryFn: ({ pageParam }) => api.tables.bases.trash(base.id, { cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const [purging, setPurging] = useState<TrashItem | null>(null);
  const canPurge = roleAtLeast(base.access, 'builder');
  const items = trash.data?.pages.flatMap((page) => page.items) ?? [];
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: tablesKeys.trash(base.id) }),
      queryClient.invalidateQueries({ queryKey: ['tables', 'records'] }),
      refreshBase(base.id),
    ]);
  };
  const restore = async (item: TrashItem) => {
    try {
      if (item.kind === 'record') await api.tables.records.restore(item.id);
      else if (item.kind === 'field') await api.tables.fields.restore(item.id);
      else await api.tables.tables.restore(item.id);
      await refresh();
      notify(t('tables.trash.restored', { name: item.name || t('tables.record.untitled') }));
    } catch (error) {
      notify(tablesError(error, t));
    }
  };
  const purge = async (item: TrashItem) => {
    try {
      if (item.kind === 'record') await api.tables.records.purge(item.id);
      else if (item.kind === 'field') await api.tables.fields.purge(item.id);
      else await api.tables.tables.purge(item.id);
      await refresh();
      notify(t('tables.trash.purged', { name: item.name || t('tables.record.untitled') }));
    } catch (error) {
      notify(tablesError(error, t));
    }
  };
  const timeZone = me?.timezone ?? 'Asia/Shanghai';
  return (
    <Overlay title={t('tables.trash.title')} help={t('tables.trash.hint')} onClose={onClose}>
      {trash.isPending ? (
        <Skeleton lines={5} />
      ) : trash.isError ? (
        <ErrorBox onRetry={() => void trash.refetch()}>{tablesError(trash.error, t)}</ErrorBox>
      ) : !items.length ? (
        <Empty icon={<Trash2 strokeWidth={icon.stroke} />} title={t('tables.trash.empty')} />
      ) : (
        <ul className="app-list" aria-label={t('tables.trash.title')}>
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`} className="app-list-row app-tb-trash-row">
              <span className="app-list-main">
                <span className="app-list-title">{item.name || t('tables.record.untitled')}</span>
                <span className="app-list-meta">
                  {t('tables.trash.meta', {
                    kind: t(`tables.trash.kind.${item.kind}`),
                    table: item.table_name,
                    time: relativeTime(item.deleted_at, { locale, timeZone }),
                  })}
                  {item.deleted_by ? ` · ${t('tables.trash.by', { name: item.deleted_by.name })}` : ''}
                </span>
              </span>
              <Button size="sm" onClick={() => void restore(item)}>
                <Undo2 size={icon.sm} strokeWidth={icon.stroke} />
                {t('tables.trash.restore')}
              </Button>
              {canPurge && (
                <IconButton size="sm" label={t('tables.trash.purge')} onClick={() => setPurging(item)}>
                  <Trash2 size={icon.sm} strokeWidth={icon.stroke} />
                </IconButton>
              )}
            </li>
          ))}
          {trash.hasNextPage && (
            <li>
              <Button kind="ghost" loading={trash.isFetchingNextPage} onClick={() => void trash.fetchNextPage()}>
                {t('common.more')}
              </Button>
            </li>
          )}
        </ul>
      )}
      {purging && (
        <ConfirmDialog
          danger
          title={t('tables.trash.purgeTitle', { name: purging.name || t('tables.record.untitled') })}
          confirmLabel={t('tables.trash.purge')}
          onCancel={() => setPurging(null)}
          onConfirm={() => {
            const item = purging;
            setPurging(null);
            void purge(item);
          }}
        >
          {t('tables.trash.purgeBody')}
        </ConfirmDialog>
      )}
    </Overlay>
  );
}

export function AuditDrawer({ base, onClose }: { base: Base; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const log = useInfiniteQuery({
    queryKey: ['tables', 'audit', base.id],
    queryFn: ({ pageParam }) => api.tables.bases.audit(base.id, { cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const items = log.data?.pages.flatMap((page) => page.items) ?? [];
  const timeZone = me?.timezone ?? 'Asia/Shanghai';
  const words = (action: string) => {
    const key = `tables.audit.action.${action}`;
    const text = t(key as Parameters<typeof t>[0]);
    return text === key ? action : text;
  };
  return (
    <Overlay title={t('tables.audit.title')} onClose={onClose}>
      {log.isPending ? (
        <Skeleton lines={5} />
      ) : log.isError ? (
        <ErrorBox onRetry={() => void log.refetch()}>{tablesError(log.error, t)}</ErrorBox>
      ) : !items.length ? (
        <Empty title={t('tables.audit.empty')} />
      ) : (
        <ul className="app-list" aria-label={t('tables.audit.title')}>
          {items.map((entry) => (
            <li key={entry.id} className="app-list-row">
              <span className="app-list-main">
                <span className="app-list-title">
                  {entry.actor?.name ?? t('tables.audit.system')} {words(entry.action)}
                </span>
                {entry.summary && <span className="app-list-meta">{entry.summary}</span>}
              </span>
              <span className="app-list-time">{relativeTime(entry.created_at, { locale, timeZone })}</span>
            </li>
          ))}
          {log.hasNextPage && (
            <li>
              <Button kind="ghost" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                {t('common.more')}
              </Button>
            </li>
          )}
        </ul>
      )}
    </Overlay>
  );
}

export function RenameBaseDialog({ base, onClose }: { base: Base; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <NameDialog
      title={t('tables.renameTitle')}
      label={t('tables.name')}
      initial={base.name}
      submit={t('tables.save')}
      onClose={onClose}
      onSave={async (name) => {
        await api.tables.bases.update(base.id, { name });
        await refreshBase(base.id);
      }}
    />
  );
}
