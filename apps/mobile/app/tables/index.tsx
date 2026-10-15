import { useCallback, useState } from 'react';
import { FlatList } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { bases } from '../../src/api/tables';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import { useAuth } from '../../src/store/auth';
import { EmptyState } from '../../src/ui/empty';
import { ListRow } from '../../src/ui/list';
import { NativeButton } from '../../src/ui/button';
import { alertError } from '../../src/ui/dialogs';
export default function Tables() {
  const t = useT();
  const router = useRouter();
  const allowed = useAuth((s) => s.user?.modules.tables);
  const r = useResource(
    useCallback(() => bases(), []),
    ['base.updated'],
  );
  const [busy, setBusy] = useState(false);
  const more = async () => {
    if (!r.data?.next_cursor || busy) return;
    setBusy(true);
    const result = await bases(r.data.next_cursor);
    setBusy(false);
    if (result.ok) r.setData((old) => (old ? { ...result.data, items: [...old.items, ...result.data.items] } : old));
    else alertError(t('work.loadFailed'), result.message);
  };
  return (
    <>
      <Stack.Screen options={{ title: t('work.tables') }} />
      {!allowed ? (
        <EmptyState icon="table" title={t('work.permissionLost')} />
      ) : !r.data ? (
        <ResourceState loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: 40 }}
          data={r.data.items}
          keyExtractor={(b) => b.id}
          refreshing={r.loading}
          onRefresh={() => void r.refresh()}
          renderItem={({ item, index }) => (
            <ListRow
              position={index === 0 ? 'first' : index === r.data!.items.length - 1 ? 'last' : 'middle'}
              title={item.name}
              icon="table"
              subtitle={item.description || undefined}
              onPress={() => router.push({ pathname: '/tables/base', params: { id: item.id } })}
              accessory="chevron"
            />
          )}
          ListEmptyComponent={<EmptyState icon="table" title={t('work.noBases')} />}
          ListFooterComponent={
            r.data.next_cursor ? (
              <NativeButton label={t('work.more')} loading={busy} onPress={() => void more()} />
            ) : null
          }
        />
      )}
    </>
  );
}
