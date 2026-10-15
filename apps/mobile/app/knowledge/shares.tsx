import { useCallback } from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { shares } from '../../src/api/knowledge';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import { ListRow, ListSection } from '../../src/ui/list';
export default function Shares() {
  const { id = '', kind = 'docs' } = useLocalSearchParams<{ id: string; kind: 'docs' | 'folders' }>();
  const t = useT();
  const r = useResource(
    useCallback(() => shares(kind, id), [kind, id]),
    ['knowledge.changed', 'doc.updated', 'comments.updated'],
  );
  return (
    <>
      <Stack.Screen options={{ title: t('work.sharing') }} />
      {!r.data ? (
        <ResourceState loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{}}>
          <ListSection header={t('work.sharing')}>
            {r.data.items.length ? (
              r.data.items.map((item, i) => (
                <ListRow key={i} title={item.name || t('work.team')} value={t(`work.${item.role}`)} />
              ))
            ) : (
              <ListRow title={t('work.noShares')} />
            )}
          </ListSection>
          {r.data.inherited.length ? (
            <ListSection header={t('work.inherited')}>
              {r.data.inherited.map((item, i) => (
                <ListRow
                  key={i}
                  title={item.name || t('work.team')}
                  subtitle={item.folder_name}
                  value={t(`work.${item.role}`)}
                />
              ))}
            </ListSection>
          ) : null}
        </ScrollView>
      )}
    </>
  );
}
