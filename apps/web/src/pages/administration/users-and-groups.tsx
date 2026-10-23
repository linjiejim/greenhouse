/**
 * Users & groups (用户与小组) — accounts and the groups used for sharing, as
 * two tabs of one admin module. The tab is the URL
 * (`#/administration/users` · `#/administration/users/groups`). Groups is the
 * same panel members use under Settings; a super sees every group there.
 */

import { Tabs } from '../../components/ui';
import { useT } from '../../lib/i18n';
import { GroupsPanel } from '../settings/groups';
import { UserManagementPanel } from './users';

export function UsersAndGroupsPanel({ subPath }: { subPath: string }) {
  const t = useT();
  const tab = subPath.split('/').filter(Boolean)[1] === 'groups' ? 'groups' : 'users';
  const tabs = (
    <Tabs
      tabs={[
        { key: 'users', label: t('usersAndGroups.tab.users') },
        { key: 'groups', label: t('usersAndGroups.tab.groups') },
      ]}
      active={tab}
      onChange={(key) => {
        window.location.hash = key === 'groups' ? '#/administration/users/groups' : '#/administration/users';
      }}
      ariaLabel={t('usersAndGroups.tabsLabel')}
    />
  );
  return tab === 'groups' ? <GroupsPanel admin={{ tabs }} /> : <UserManagementPanel tabs={tabs} />;
}
