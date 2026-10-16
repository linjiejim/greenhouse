import { useCallback, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { agentMemories, forgetMemory, updateMemory } from '../../src/api/agents';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import type { AgentMemory } from '../../src/shared/contract';
import { EmptyState } from '../../src/ui/empty';
import { ListRow } from '../../src/ui/list';
import { NativeMenu } from '../../src/ui/menu';
import { alertError, confirmAction } from '../../src/ui/dialogs';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

export default function Memories() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const router = useRouter();
  const r = useResource(useCallback(() => agentMemories(id), [id]));
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const act = async (item: AgentMemory, action: string) => {
    if (action === 'activate') {
      router.push({ pathname: '/agents/memory', params: { id, memory: item.id } });
      return;
    }
    if (action !== 'pin' && action !== 'forget') return;
    if (pending.current) return;
    const current = r.captureWrite();
    if (
      action === 'forget' &&
      !(await confirmAction({
        title: t('integration.forgetMemory'),
        message: t('integration.forgetHint'),
        confirmLabel: t('row.delete'),
        destructive: true,
      }))
    )
      return;
    if (!current() || pending.current) return;
    pending.current = true;
    setBusy(true);
    const result =
      action === 'forget' ? await forgetMemory(id, item.id) : await updateMemory(id, item.id, { pinned: !item.pinned });
    pending.current = false;
    setBusy(false);
    if (!current()) return;
    if (result.ok) void r.refresh();
    else alertError(t('work.saveFailed'), undefined, result.message);
  };
  const list = [...(r.data?.items ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  return (
    <>
      <Stack.Screen options={{ title: t('integration.memories') }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('plus')}
          accessibilityLabel={t('integration.newMemory')}
          onPress={() => router.push({ pathname: '/agents/memory', params: { id } })}
        />
      </Stack.Toolbar>
      {!r.data ? (
        <ResourceState error={r.error} loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          data={list}
          keyExtractor={(item) => item.id}
          refreshing={r.loading}
          onRefresh={() => void r.refresh()}
          renderItem={({ item, index }) => {
            const items = [
              {
                id: 'pin',
                title: t(item.pinned ? 'integration.unpinMemory' : 'integration.pinMemory'),
                icon: 'pin' as const,
              },
              { id: 'forget', title: t('row.delete'), icon: 'trash' as const, destructive: true },
            ];
            return (
              <NativeMenu trigger="longPress" items={items} onSelect={(action) => void act(item, action)}>
                <ListRow
                  title={item.title}
                  titleLines={0}
                  subtitle={item.content}
                  icon={item.pinned ? 'pin' : 'book'}
                  disabled={busy}
                  accessory="chevron"
                  position={
                    list.length === 1 ? 'only' : index === 0 ? 'first' : index === list.length - 1 ? 'last' : 'middle'
                  }
                  accessibilityActions={items.map((action) => ({ name: action.id, label: action.title }))}
                  onAccessibilityAction={(event) => void act(item, event.nativeEvent.actionName)}
                  onPress={() => router.push({ pathname: '/agents/memory', params: { id, memory: item.id } })}
                />
              </NativeMenu>
            );
          }}
          ListEmptyComponent={<EmptyState icon="book" title={t('integration.noMemories')} />}
        />
      )}
    </>
  );
}
