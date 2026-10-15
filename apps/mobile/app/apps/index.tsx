import { matchesDirectory } from '../../src/data/directory-filter';
import { DirectorySearch, useDirectoryFilter } from '../../src/ui/directory-search';
import { useCallback, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { apps } from '../../src/api/apps';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import { useAuth } from '../../src/store/auth';
import { ListRow, ListSectionFooter } from '../../src/ui/list';
import { EmptyState } from '../../src/ui/empty';
import { NativeButton } from '../../src/ui/button';
import { alertError } from '../../src/ui/dialogs';

export default function Apps() {
  const t = useT();
  const filter = useDirectoryFilter();
  const router = useRouter();
  const allowed = useAuth((s) => s.user?.modules.apps);
  const r = useResource(useCallback(() => apps(), []));
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const more = async () => {
    if (!r.data?.next_cursor || pending.current) return;
    const current = r.capture();
    pending.current = true;
    setBusy(true);
    const result = await apps({ cursor: r.data.next_cursor });
    pending.current = false;
    setBusy(false);
    if (!current()) return;
    if (result.ok)
      r.setData((old) =>
        old
          ? {
              ...result.data,
              items: [...old.items, ...result.data.items.filter((a) => !old.items.some((b) => a.id === b.id))],
            }
          : old,
      );
    else alertError(t('work.loadFailed'), result.message);
  };
  const published =
    r.data?.items.filter((a) => a.status === 'published' && matchesDirectory(filter.query, a.name)) ?? [];
  return (
    <>
      <Stack.Screen options={{ title: t('integration.apps') }} />
      <DirectorySearch filter={filter} />
      {!allowed ? (
        <EmptyState icon="table" title={t('work.permissionLost')} />
      ) : !r.data ? (
        <ResourceState loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: 40 }}
          data={published}
          keyExtractor={(a) => a.id}
          refreshing={r.loading}
          onRefresh={() => void r.refresh()}
          renderItem={({ item, index }) => (
            <ListRow
              position={
                published.length === 1
                  ? 'only'
                  : index === 0
                    ? 'first'
                    : index === published.length - 1
                      ? 'last'
                      : 'middle'
              }
              title={item.name}
              subtitle={item.description || undefined}
              icon="table"
              accessory="chevron"
              onPress={() => router.push({ pathname: '/apps/runtime', params: { id: item.id } })}
            />
          )}
          ListEmptyComponent={
            <EmptyState icon="table" title={t(filter.query.trim() ? 'directory.noMatches' : 'integration.noApps')} />
          }
          ListFooterComponent={
            <>
              {r.data.next_cursor ? (
                <NativeButton label={t('work.more')} loading={busy} onPress={() => void more()} />
              ) : null}
              <ListSectionFooter text={t('integration.builderWeb')} />
            </>
          }
        />
      )}
    </>
  );
}
