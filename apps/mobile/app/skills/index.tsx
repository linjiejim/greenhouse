import { useCallback, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { listSkills } from '../../src/api/me';
import { useComposerBridge } from '../../src/chat/composer-bridge';
import { matchesDirectory } from '../../src/data/directory-filter';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import { openNewChat } from '../../src/shell/nav';
import { DirectorySearch, useDirectoryFilter } from '../../src/ui/directory-search';
import { EmptyState } from '../../src/ui/empty';
import { ListRow } from '../../src/ui/list';
import { NativeButton } from '../../src/ui/button';
import { alertError } from '../../src/ui/dialogs';

export default function Skills() {
  const t = useT();
  const router = useRouter();
  const filter = useDirectoryFilter();
  const r = useResource(useCallback(() => listSkills({ limit: 100 }), []));
  const pending = useRef(false);
  const [paging, setPaging] = useState(false);
  const list = (r.data?.items ?? []).filter((item) => matchesDirectory(filter.query, item.name, item.display_name));
  const more = async () => {
    if (!r.data?.next_cursor || pending.current) return;
    const current = r.capture();
    pending.current = true;
    setPaging(true);
    const result = await listSkills({ cursor: r.data.next_cursor, limit: 100 });
    pending.current = false;
    setPaging(false);
    if (!current()) return;
    if (result.ok)
      r.setData((old) =>
        old
          ? {
              ...result.data,
              items: [
                ...old.items,
                ...result.data.items.filter((item) => !old.items.some((known) => known.id === item.id)),
              ],
            }
          : old,
      );
    else alertError(t('work.loadFailed'), undefined, result.message);
  };
  return (
    <>
      <Stack.Screen options={{ title: t('integration.skills') }} />
      <DirectorySearch filter={filter} />
      {!r.data ? (
        <ResourceState loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: 40 }}
          data={list}
          keyExtractor={(item) => item.id}
          refreshing={r.loading}
          onRefresh={() => void r.refresh()}
          renderItem={({ item, index }) => (
            <ListRow
              title={item.display_name || item.name}
              titleLines={0}
              icon="sparkle"
              subtitle={item.unavailable?.message || item.description || '/' + item.name}
              disabled={!item.available}
              accessibilityLabel={[
                item.display_name || item.name,
                item.unavailable?.message || t('integration.useSkill'),
              ].join(' · ')}
              position={
                list.length === 1 ? 'only' : index === 0 ? 'first' : index === list.length - 1 ? 'last' : 'middle'
              }
              onPress={() => {
                useComposerBridge.setState({ skill: item });
                openNewChat(router, { compose: true }, 'dismissTo');
              }}
            />
          )}
          ListEmptyComponent={
            <EmptyState
              icon="sparkle"
              title={t(filter.query.trim() ? 'directory.noMatches' : 'integration.noSkills')}
            />
          }
          ListFooterComponent={
            r.data.next_cursor ? (
              <NativeButton label={t('work.more')} loading={paging} onPress={() => void more()} />
            ) : null
          }
        />
      )}
    </>
  );
}
