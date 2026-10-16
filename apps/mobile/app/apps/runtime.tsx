import { useCallback, useEffect, useState } from 'react';
import { FlatList, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { memberDirectory } from '../../src/api/me';
import { appRuntime } from '../../src/api/apps';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { RuntimeCard } from '../../src/apps/card';
import { useT } from '../../src/lib/i18n';
import { useAuth } from '../../src/store/auth';
import { EmptyState } from '../../src/ui/empty';
import { NativeMenu } from '../../src/ui/menu';
import { NativeButton } from '../../src/ui/button';
import { ListSectionFooter } from '../../src/ui/list';
import { space } from '../../src/theme';

export default function Runtime() {
  const { id = '', page: initialPage } = useLocalSearchParams<{ id: string; page?: string }>();
  const t = useT();
  const members = useResource(useCallback(() => memberDirectory(), []));
  const names = Object.fromEntries((members.data?.items ?? []).map((member) => [member.id, member.name]));
  const allowed = useAuth((s) => s.user?.modules.apps);
  const [page, setPage] = useState(initialPage);
  const r = useResource(
    useCallback(() => appRuntime(id), [id]),
    ['base.updated'],
  );
  useEffect(() => setPage(initialPage), [id, initialPage]);
  const runtime = r.data?.app.id === id ? r.data : null;
  const current = runtime?.pages.find((p) => p.id === page) ?? runtime?.pages[0];
  return (
    <>
      <Stack.Screen options={{ title: runtime?.app.name ?? t('integration.apps') }} />
      {!allowed ? (
        <EmptyState icon="table" title={t('work.permissionLost')} />
      ) : !runtime ? (
        <ResourceState error={r.error} loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <FlatList
          key={`${id}:${runtime.version}:${current?.id}`}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: 40 }}
          data={current?.cards ?? []}
          keyExtractor={(card) => `${runtime.version}:${card.id}`}
          renderItem={({ item }) => <RuntimeCard runtime={runtime} card={item} names={names} />}
          initialNumToRender={2}
          maxToRenderPerBatch={2}
          windowSize={3}
          ListHeaderComponent={
            <>
              <View
                style={{
                  margin: space.margin,
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  gap: space.sm,
                }}
              >
                <NativeMenu
                  items={runtime.pages.map((p) => ({ id: p.id, title: p.name, checked: current?.id === p.id }))}
                  onSelect={setPage}
                >
                  <NativeButton label={current?.name ?? t('integration.pages')} icon="chevUpDown" onPress={() => {}} />
                </NativeMenu>
                <NativeButton
                  label={t('work.reload')}
                  icon="refresh"
                  loading={r.loading}
                  onPress={() => void r.refresh()}
                />
              </View>
              {r.error ? (
                <EmptyState icon="alert" title={t('work.loadFailed')} onRetry={() => void r.refresh()} />
              ) : null}
              {runtime.preview || runtime.version === 0 ? <ListSectionFooter text={t('integration.preview')} /> : null}
            </>
          }
          ListEmptyComponent={<EmptyState icon="table" title={t('integration.emptyPage')} />}
        />
      )}
    </>
  );
}
