import { useCallback } from 'react';
import { FlatList } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { forms } from '../../src/api/tables';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import { ListRow } from '../../src/ui/list';
export default function Forms() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const router = useRouter();
  const r = useResource(
    useCallback(() => forms(id), [id]),
    ['base.updated'],
  );
  return (
    <>
      <Stack.Screen options={{ title: t('work.forms') }} />
      {!r.data ? (
        <ResourceState error={r.error} loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{}}
          data={r.data.items}
          keyExtractor={(f) => f.id}
          renderItem={({ item }) => (
            <ListRow
              title={item.name}
              subtitle={item.status === 'draft' ? t('work.draft') : undefined}
              accessory="chevron"
              onPress={() => router.push({ pathname: '/tables/form', params: { id: item.id } })}
            />
          )}
        />
      )}
    </>
  );
}
