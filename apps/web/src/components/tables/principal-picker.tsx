/**
 * PrincipalPicker — the one people / groups (/ everyone) picker for Tables:
 * Base sharing, form audiences, automation recipients and app audiences all
 * use it (spec 20261011-tables-foundation D11).
 *
 * People come from the internal directory; groups from the groups the viewer
 * can see (`/api/groups` — their own and the ones they belong to; super sees
 * all), which is also the set the server lets them grant. Each group shows who
 * manages its membership, because granting a group delegates "who gets in".
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { ShareableUser, UserGroup } from '@greenhouse/types/api';
import { Badge, Checkbox, IconButton, SearchInput, Spinner, Toggle } from '../ui';
import { Users, X } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { fetchShareableUsers } from '../../lib/api';
import { listGroups } from '../../lib/api/groups';

export interface PrincipalSelection {
  userIds: string[];
  groupIds: number[];
  /** Everyone in the workspace. Only meaningful when `allowEveryone` is set. */
  everyone?: boolean;
}

export interface PrincipalPickerProps {
  value: PrincipalSelection;
  onChange: (next: PrincipalSelection) => void;
  allowGroups?: boolean;
  allowEveryone?: boolean;
  /** Ids that are already granted elsewhere and should not be offered again. */
  excludeUserIds?: readonly string[];
  excludeGroupIds?: readonly number[];
  /** Directory override (tests, or a caller that already loaded it). */
  users?: readonly ShareableUser[];
  groups?: readonly UserGroup[];
  disabled?: boolean;
}

function toggleIn<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((value) => value !== item) : [...list, item];
}

export function PrincipalPicker({
  value,
  onChange,
  allowGroups = true,
  allowEveryone = false,
  excludeUserIds = [],
  excludeGroupIds = [],
  users: providedUsers,
  groups: providedGroups,
  disabled = false,
}: PrincipalPickerProps) {
  const t = useT();
  const [users, setUsers] = useState<readonly ShareableUser[]>(providedUsers ?? []);
  const [groups, setGroups] = useState<readonly UserGroup[]>(providedGroups ?? []);
  const [loading, setLoading] = useState(!providedUsers || (allowGroups && !providedGroups));
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (providedUsers && (!allowGroups || providedGroups)) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      providedUsers ? Promise.resolve(providedUsers) : fetchShareableUsers(),
      allowGroups ? (providedGroups ? Promise.resolve(providedGroups) : listGroups()) : Promise.resolve([]),
    ])
      .then(([loadedUsers, loadedGroups]) => {
        if (cancelled) return;
        setUsers(loadedUsers);
        setGroups(loadedGroups);
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [providedUsers, providedGroups, allowGroups]);

  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const query = search.trim().toLowerCase();
  const visibleUsers = users.filter(
    (user) =>
      !excludeUserIds.includes(user.id) &&
      (!query || user.nickname.toLowerCase().includes(query) || user.email.toLowerCase().includes(query)),
  );
  const visibleGroups = groups.filter(
    (group) => !excludeGroupIds.includes(group.id) && (!query || group.name.toLowerCase().includes(query)),
  );
  const everyone = allowEveryone && value.everyone === true;
  const selectedCount = value.userIds.length + value.groupIds.length + (everyone ? 1 : 0);

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }
  if (failed) return <p className="text-sm text-danger">{t('tables.principals.loadFailed')}</p>;

  return (
    <div className="space-y-3" data-testid="principal-picker">
      {allowEveryone && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-edge px-3 py-2">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">{t('tables.principals.everyone')}</div>
            <div className="text-xs text-fg-muted">{t('tables.principals.everyoneHint')}</div>
          </div>
          <Toggle
            checked={everyone}
            disabled={disabled}
            onChange={(checked) => onChange({ ...value, everyone: checked })}
            label={t('tables.principals.everyone')}
          />
        </div>
      )}

      {selectedCount > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          aria-label={t('tables.principals.selectedCount', { count: selectedCount })}
        >
          {value.groupIds.map((groupId) => {
            const name = groupsById.get(groupId)?.name ?? `#${groupId}`;
            return (
              <Badge key={`g${groupId}`} variant="secondary">
                <Users size={10} className="mr-1" />
                {name}
                <IconButton
                  size="compact"
                  label={t('tables.principals.remove', { name })}
                  disabled={disabled}
                  onClick={() => onChange({ ...value, groupIds: value.groupIds.filter((id) => id !== groupId) })}
                >
                  <X size={10} />
                </IconButton>
              </Badge>
            );
          })}
          {value.userIds.map((userId) => {
            const name = usersById.get(userId)?.nickname ?? userId;
            return (
              <Badge key={`u${userId}`}>
                {name}
                <IconButton
                  size="compact"
                  label={t('tables.principals.remove', { name })}
                  disabled={disabled}
                  onClick={() => onChange({ ...value, userIds: value.userIds.filter((id) => id !== userId) })}
                >
                  <X size={10} />
                </IconButton>
              </Badge>
            );
          })}
        </div>
      )}

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder={t('tables.principals.searchPeople')}
        aria-label={t('tables.principals.searchPeople')}
      />

      {allowGroups && (
        <section>
          <h4 className="text-xs font-medium text-fg-muted">{t('tables.principals.groups')}</h4>
          {visibleGroups.length === 0 ? (
            <p className="mt-1 text-xs text-fg-faint">{t('tables.principals.noGroups')}</p>
          ) : (
            <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-edge divide-y divide-edge">
              {visibleGroups.map((group) => {
                const manager = usersById.get(group.created_by)?.nickname ?? group.created_by;
                return (
                  <li key={group.id} className="px-3 py-2">
                    <Checkbox
                      checked={value.groupIds.includes(group.id)}
                      disabled={disabled}
                      onChange={() => onChange({ ...value, groupIds: toggleIn(value.groupIds, group.id) })}
                      label={
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-sm text-fg">
                            {group.name}
                            {group.member_count !== undefined && (
                              <span className="ml-1.5 text-xs text-fg-faint">
                                {t('tables.principals.memberCount', { count: group.member_count })}
                              </span>
                            )}
                          </span>
                          <span className="truncate text-xs text-fg-muted">
                            {t('tables.principals.managedBy', { name: manager })}
                          </span>
                        </span>
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section>
        <h4 className="text-xs font-medium text-fg-muted">{t('tables.principals.people')}</h4>
        {visibleUsers.length === 0 ? (
          <p className="mt-1 text-xs text-fg-faint">{t('tables.principals.noPeople')}</p>
        ) : (
          <ul className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-edge divide-y divide-edge">
            {visibleUsers.map((user) => (
              <li key={user.id} className="px-3 py-2">
                <Checkbox
                  checked={value.userIds.includes(user.id)}
                  disabled={disabled}
                  onChange={() => onChange({ ...value, userIds: toggleIn(value.userIds, user.id) })}
                  label={
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm text-fg">{user.nickname}</span>
                      <span className="truncate text-xs text-fg-muted">{user.email}</span>
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
