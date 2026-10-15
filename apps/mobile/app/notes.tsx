import { useCallback, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { del, get, patch, seg } from '../src/api/client';
import { useResource } from '../src/data/use-resource';
import { ResourceState } from '../src/knowledge/state';
import { useT } from '../src/lib/i18n';
import { putHandoff } from '../src/lib/handoff';
import type { Note, Page } from '../src/shared/contract';
import { EmptyState } from '../src/ui/empty';
import { ListRow } from '../src/ui/list';
import { NativeMenu } from '../src/ui/menu';
import { NativeButton } from '../src/ui/button';
import { alertError, confirmAction } from '../src/ui/dialogs';
import { SheetClose } from '../src/ui/sheet-chrome';
import { toolbarIcon } from '../src/ui/toolbar-icon';

export default function Notes() {
  const { c = '' } = useLocalSearchParams<{ c: string }>();
  const t = useT();
  const router = useRouter();
  const base = `/api/conversations/${seg(c)}/notes`;
  const r = useResource(
    useCallback(() => get<Page<Note>>(base), [base]),
    ['notes.updated'],
  );
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const act = async (action: string, note?: Note) => {
    if (action === 'activate') action = 'edit';
    if (!['add', 'edit', 'pin', 'delete'].includes(action)) return;
    if (pending.current) return;
    if (action === 'add' || action === 'edit') {
      router.push({ pathname: '/note', params: { c, ...(note ? { k: putHandoff('note', note) } : {}) } });
      return;
    }
    const current = r.captureWrite();
    pending.current = true;
    setBusy(true);
    try {
      if (
        action === 'delete' &&
        !(await confirmAction({ title: t('integration.deleteNote'), confirmLabel: t('row.delete'), destructive: true }))
      )
        return;
      if (!current()) return;
      const result =
        action === 'delete'
          ? await del(`${base}/${seg(note!.id)}`)
          : await patch<Note>(`${base}/${seg(note!.id)}`, { pinned: !note!.pinned });
      if (!current()) return;
      if (result.ok) void r.refresh();
      else alertError(t('work.saveFailed'), undefined, result.message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const more = async () => {
    if (!r.data?.next_cursor || pending.current) return;
    const current = r.capture();
    pending.current = true;
    setBusy(true);
    const result = await get<Page<Note>>(base, { cursor: r.data.next_cursor });
    pending.current = false;
    setBusy(false);
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
  const list = r.data?.items ?? [];
  return (
    <>
      <Stack.Screen options={{ title: t('integration.notes') }} />
      <SheetClose />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('plus')}
          disabled={busy}
          accessibilityLabel={t('integration.newNote')}
          onPress={() => void act('add')}
        />
      </Stack.Toolbar>
      {!r.data ? (
        <ResourceState loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          data={list}
          keyExtractor={(item) => item.id}
          refreshing={r.loading}
          onRefresh={() => void r.refresh()}
          renderItem={({ item, index }) => {
            const menu = [
              { id: 'edit', title: t('integration.editNote'), icon: 'pen' as const },
              { id: 'pin', title: t(item.pinned ? 'row.unpin' : 'row.pin'), icon: 'pin' as const },
              { id: 'delete', title: t('row.delete'), icon: 'trash' as const, destructive: true },
            ];
            return (
              <NativeMenu trigger="longPress" items={menu} onSelect={(action) => void act(action, item)}>
                <ListRow
                  title={item.title || item.body}
                  titleLines={0}
                  subtitle={item.title ? item.body : undefined}
                  subtitleLines={0}
                  icon={item.pinned ? 'pin' : 'book'}
                  disabled={busy}
                  position={
                    list.length === 1 ? 'only' : index === 0 ? 'first' : index === list.length - 1 ? 'last' : 'middle'
                  }
                  onPress={() => void act('edit', item)}
                  accessibilityActions={menu.map((action) => ({ name: action.id, label: action.title }))}
                  onAccessibilityAction={(event) => void act(event.nativeEvent.actionName, item)}
                />
              </NativeMenu>
            );
          }}
          ListEmptyComponent={<EmptyState icon="book" title={t('integration.noNotes')} />}
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
