/**
 * The Agent directory (AGNT-16; a large-title page, from 更多 or 「全部 Agents」 in the drawer):
 * 我的 (my Agents, the main one first), 公开 (other members' public Agents shared with me) and
 * 已归档 (mine, archived — each can come back). ＋ in the bar creates one (AGNT-02).
 *
 * A row of mine opens its profile; a public one opens its Agent thread (made on first use) —
 * that is how a public Agent is talked to.
 */

import { matchesDirectory } from '../../src/data/directory-filter';
import { DirectorySearch, useDirectoryFilter } from '../../src/ui/directory-search';
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useResource } from '../../src/data/use-resource';
import { listAgents, restoreAgent } from '../../src/api/agents';
import { createConversation } from '../../src/api/conversations';
import { useT } from '../../src/lib/i18n';
import type { Agent, PublicAgent } from '../../src/shared/contract';
import { openConversation } from '../../src/shell/nav';
import { useWorkspace } from '../../src/store/workspace';
import { makeStyles, space, useTheme } from '../../src/theme';
import { AgentAvatar } from '../../src/ui/agent-avatar';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, type RowPosition } from '../../src/ui/list';
import { NativeMenu } from '../../src/ui/menu';
import { Segmented } from '../../src/ui/segmented';
import { toast } from '../../src/ui/toast';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

type Scope = 'mine' | 'public' | 'archived';

const position = (index: number, count: number): RowPosition =>
  count === 1 ? 'only' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle';

export default function Agents() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const filter = useDirectoryFilter();
  const router = useRouter();
  const mine = useWorkspace((s) => s.agents);
  const shared = useWorkspace((s) => s.publicAgents);
  const conversations = useWorkspace((s) => s.conversations);
  const [scope, setScope] = useState<Scope>('mine');
  const archivedResource = useResource(useCallback(() => listAgents('archived'), []));
  const archived = archivedResource.data?.items ?? null;
  const loadArchived = archivedResource.refresh;
  const [refreshing, setRefreshing] = useState(false);
  const loadFailed = useWorkspace((s) => s.loadFailed);
  useEffect(() => {
    void useWorkspace.getState().refreshAgents();
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([
      useWorkspace.getState().refreshAgents(),
      scope === 'archived' ? loadArchived() : Promise.resolve(),
    ]);
    setRefreshing(false);
  };

  const talkTo = async (agent: PublicAgent) => {
    const known = conversations?.find((item) => item.kind === 'direct' && item.agent_id === agent.id);
    if (known) {
      openConversation(router, { id: known.id, title: agent.name }, 'dismissTo');
      return;
    }
    const made = await createConversation({ kind: 'direct', agent_id: agent.id });
    if (!made.ok) {
      alertError(t('directory.openFailed'), made.message || undefined);
      return;
    }
    useWorkspace.getState().putConversation(made.data);
    openConversation(router, { id: made.data.id, title: agent.name }, 'dismissTo');
  };

  const restore = async (agent: Agent) => {
    const result = await restoreAgent(agent.id);
    if (!result.ok) {
      alertError(t('agents.restoreFailed'), result.message || undefined);
      return;
    }
    toast(t('agents.restored', { name: agent.name }), 'check');
    void loadArchived();
    void useWorkspace.getState().refresh();
  };

  const entries: (Agent | PublicAgent)[] =
    scope === 'mine'
      ? [...(mine ?? [])].sort((a, b) => Number(b.is_main) - Number(a.is_main))
      : scope === 'public'
        ? shared
        : (archived ?? []);
  const list = entries.filter((item) => matchesDirectory(filter.query, item.name, item.role));
  const loading = scope === 'mine' ? mine === null : scope === 'archived' ? archived === null : false;

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: t('agents.title') }} />
      <DirectorySearch filter={filter} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('plus')}
          accessibilityLabel={t('agents.new')}
          onPress={() => router.push('/agents/edit')}
        />
      </Stack.Toolbar>
      <FlatList<Agent | PublicAgent>
        contentInsetAdjustmentBehavior="automatic"
        data={list}
        keyExtractor={(agent) => agent.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        ListHeaderComponent={
          <Segmented<Scope>
            value={scope}
            onChange={setScope}
            options={[
              { value: 'mine', label: t('agents.mine') },
              { value: 'public', label: t('agents.public') },
              { value: 'archived', label: t('agents.archivedTab') },
            ]}
            style={styles.segmented}
          />
        }
        renderItem={({ item, index }) => {
          const owner = 'owner' in item ? item.owner.name : null;
          const subtitle = [
            item.role,
            owner ? t('directory.sharedBy', { name: owner }) : '',
            item.is_main ? t('agents.main') : '',
          ]
            .filter(Boolean)
            .join(' · ');
          const row = (
            <ListRow
              title={item.name}
              subtitle={subtitle || undefined}
              leading={
                <AgentAvatar
                  agent={item}
                  size={34}
                  animate={false}
                  state={scope === 'archived' ? 'sleep' : undefined}
                />
              }
              leadingWidth={34}
              accessory="chevron"
              position={position(index, list.length)}
              onPress={() => {
                if (scope === 'public') void talkTo(item as PublicAgent);
                else router.push({ pathname: '/agents/[id]', params: { id: item.id } });
              }}
            />
          );
          if (scope !== 'archived') return row;
          return (
            <NativeMenu
              trigger="longPress"
              items={[{ id: 'restore', title: t('agents.restore'), icon: 'rotate' }]}
              onSelect={() => void restore(item as Agent)}
            >
              {row}
            </NativeMenu>
          );
        }}
        ListEmptyComponent={
          (scope === 'archived' ? !!archivedResource.error : loadFailed) ? (
            <EmptyState icon="alert" title={t('agents.loadFailed')} onRetry={() => void refresh()} />
          ) : loading ? (
            <LoadingState style={styles.empty} />
          ) : filter.query.trim() ? (
            <EmptyState icon="search" title={t('directory.noMatches')} />
          ) : scope === 'public' ? (
            <EmptyState icon="sparkle" title={t('agents.nonePublic')} />
          ) : scope === 'archived' ? (
            <EmptyState icon="archive" title={t('agents.noneArchived')} />
          ) : (
            <EmptyState icon="sparkle" title={t('agents.none')} />
          )
        }
        ListFooterComponent={<View style={{ height: space.xxl }} />}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  segmented: { marginHorizontal: space.margin, marginVertical: space.md },
  empty: { paddingTop: space.xxl },
}));
