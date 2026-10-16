import { useCallback, useRef, useState } from 'react';
import { FlatList, ScrollView } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { versions, versionDetail } from '../../src/api/knowledge';
import { useResource } from '../../src/data/use-resource';
import { visiblePages } from '../../src/data/pages';
import { relativeTimeNow } from '../../src/lib/time-words';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import { Markdown } from '../../src/chat/markdown';
import type { DocVersionDetail } from '../../src/shared/contract';
import { ListRow } from '../../src/ui/list';
import { NativeButton } from '../../src/ui/button';
import { alertError } from '../../src/ui/dialogs';
export default function Versions() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const visible = useRef(1);
  const busy = useRef(false);
  const r = useResource(
    useCallback(() => visiblePages((cursor) => versions(id, cursor), visible.current), [id]),
    ['knowledge.changed', 'doc.updated', 'comments.updated'],
  );
  const [picked, setPicked] = useState<DocVersionDetail | null>(null);
  const open = async (n: number) => {
    const current = r.captureWrite();
    const result = await versionDetail(id, n);
    if (!current()) return;
    if (result.ok) setPicked(result.data);
    else alertError(t('work.loadFailed'), result.message);
  };
  const more = async () => {
    if (!r.data?.next_cursor || busy.current) return;
    const current = r.capture();
    busy.current = true;
    const result = await versions(id, r.data.next_cursor);
    busy.current = false;
    if (!current()) return;
    if (result.ok) {
      visible.current++;
      r.setData((old) => (old ? { ...result.data, items: [...old.items, ...result.data.items] } : old));
    } else alertError(t('work.loadFailed'), result.message);
  };
  return (
    <>
      <Stack.Screen options={{ title: t('work.versions') }} />
      {picked ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 16 }}>
          <NativeButton label={t('work.versions')} onPress={() => setPicked(null)} />
          <Markdown source={picked.content} safe />
        </ScrollView>
      ) : !r.data ? (
        <ResourceState error={r.error} loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: 40 }}
          data={r.data.items}
          keyExtractor={(v) => String(v.version)}
          renderItem={({ item }) => (
            <ListRow
              title={t('work.version', { n: item.version })}
              subtitle={[item.created_by?.name, item.change_note].filter(Boolean).join(' · ')}
              value={relativeTimeNow(item.created_at)}
              onPress={() => void open(item.version)}
              accessory="chevron"
            />
          )}
          ListFooterComponent={
            r.data.next_cursor ? <NativeButton label={t('work.more')} onPress={() => void more()} /> : null
          }
        />
      )}
    </>
  );
}
