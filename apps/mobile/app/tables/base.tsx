import { useCallback } from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { base } from '../../src/api/tables';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import { ListRow, ListSection } from '../../src/ui/list';
export default function Base() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const router = useRouter();
  const r = useResource(
    useCallback(() => base(id), [id]),
    ['base.updated'],
  );
  return (
    <>
      <Stack.Screen options={{ title: r.data?.name ?? t('work.tables') }} />
      {!r.data ? (
        <ResourceState error={r.error} loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: 40 }}>
          {r.data.tables.map((table) => (
            <ListSection key={table.id} header={table.name}>
              {r
                .data!.views.filter((v) => v.table_id === table.id)
                .map((v) => (
                  <ListRow
                    key={v.id}
                    title={v.name}
                    icon="table"
                    onPress={() =>
                      router.push({ pathname: '/tables/view', params: { base: id, table: table.id, view: v.id } })
                    }
                    accessory="chevron"
                  />
                ))}
              {!r.data!.views.some((v) => v.table_id === table.id) ? (
                <ListRow
                  title={t('work.records')}
                  onPress={() => router.push({ pathname: '/tables/view', params: { base: id, table: table.id } })}
                  accessory="chevron"
                />
              ) : null}
              {['owner', 'builder'].includes(r.data!.access) ? (
                <ListRow
                  title={t('work.forms')}
                  icon="form"
                  onPress={() => router.push({ pathname: '/tables/forms', params: { id: table.id } })}
                  accessory="chevron"
                />
              ) : null}
            </ListSection>
          ))}
        </ScrollView>
      )}
    </>
  );
}
