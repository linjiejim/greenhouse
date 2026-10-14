import { useCallback, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { standingApprovals, revokeApproval } from '../../src/api/always-on';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import { ListRow } from '../../src/ui/list';
import { EmptyState } from '../../src/ui/empty';
import { NativeButton } from '../../src/ui/button';
import { alertError } from '../../src/ui/dialogs';

export default function Standing() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const actionsOf = (actions: string[]) =>
    actions
      .map((action) =>
        t(
          action.endsWith('.create')
            ? 'integration.scopeCreate'
            : action.endsWith('.comment')
              ? 'integration.scopeComment'
              : action.endsWith('.delete')
                ? 'integration.scopeDelete'
                : 'integration.scopeEdit',
        ),
      )
      .join(' · ');
  const r = useResource(useCallback(() => standingApprovals(id), [id]));
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const revoke = async (approval: string) => {
    if (pending.current) return;
    const current = r.captureWrite();
    pending.current = true;
    const result = await revokeApproval(id, approval);
    pending.current = false;
    if (!current()) return;
    if (result.ok) {
      r.setData((old) => (old ? { ...old, items: old.items.filter((item) => item.id !== approval) } : old));
      void r.refresh();
    } else alertError(t('work.saveFailed'), undefined, result.message);
  };
  const more = async () => {
    if (!r.data?.next_cursor || busy) return;
    const current = r.capture();
    setBusy(true);
    const result = await standingApprovals(id, r.data.next_cursor);
    if (!current()) {
      setBusy(false);
      return;
    }
    setBusy(false);
    if (result.ok) r.setData((old) => (old ? { ...result.data, items: [...old.items, ...result.data.items] } : old));
    else alertError(t('work.loadFailed'), result.message);
  };
  return (
    <>
      <Stack.Screen options={{ title: t('integration.standing') }} />
      {!r.data ? (
        <ResourceState loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          data={r.data.items}
          keyExtractor={(a) => a.id}
          refreshing={r.loading}
          onRefresh={() => void r.refresh()}
          renderItem={({ item, index }) => (
            <ListRow
              position={
                r.data!.items.length === 1
                  ? 'only'
                  : index === 0
                    ? 'first'
                    : index === r.data!.items.length - 1
                      ? 'last'
                      : 'middle'
              }
              title={item.scope_name || t(item.scope_type === 'folder' ? 'integration.folder' : 'integration.table')}
              subtitle={actionsOf(item.actions)}
              value={t('integration.revoke')}
              onPress={() => void revoke(item.id)}
              accessibilityLabel={`${item.scope_name || item.scope_type}, ${actionsOf(item.actions)}, ${t('integration.revoke')}`}
            />
          )}
          ListEmptyComponent={
            <EmptyState
              icon="shieldCheck"
              title={t('integration.noStanding')}
              message={t('integration.standingHint')}
            />
          }
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
