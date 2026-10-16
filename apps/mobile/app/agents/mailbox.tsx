import { visiblePages } from '../../src/data/pages';
import { useAuth } from '../../src/store/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useIsFocused } from 'expo-router';
import { mailbox, mail, addSender, removeSender } from '../../src/api/mail';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import { ListSection, ListRow } from '../../src/ui/list';
import { NativeButton } from '../../src/ui/button';
import { NativeMenu } from '../../src/ui/menu';
import { alertError, promptText, confirmAction } from '../../src/ui/dialogs';
import { useTheme, typo, space } from '../../src/theme';
export default function Mailbox() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const box = useResource(
    useCallback(() => mailbox(id), [id]),
    ['message.created'],
  );
  const shown = useRef({ all: 1, held: 1 });
  const focused = useIsFocused();
  const me = useAuth((s) => s.user);
  const held = useResource(
    useCallback(() => visiblePages((cursor) => mail(id, cursor, 'screened'), shown.current.held), [id]),
    ['message.created'],
  );
  const list = useResource(
    useCallback(() => visiblePages((cursor) => mail(id, cursor), shown.current.all), [id]),
    ['message.created'],
  );
  const boxRefresh = box.refresh;
  const heldRefresh = held.refresh;
  const listRefresh = list.refresh;
  useEffect(() => {
    if (!focused) return;
    const timer = setInterval(() => {
      void boxRefresh();
      void heldRefresh();
      void listRefresh();
    }, 20000);
    return () => clearInterval(timer);
  }, [focused, boxRefresh, heldRefresh, listRefresh]);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const current = box.captureWrite();
    const address = await promptText({ title: t('work.addSender'), placeholder: t('work.address') });
    if (!address || !current()) return;
    const result = await addSender(id, address);
    if (!current()) return;
    if (!result.ok) alertError(t('work.saveFailed'), undefined, result.message);
    else box.setData(result.data);
  };
  const remove = async (address: string) => {
    const current = box.captureWrite();
    if (
      !(await confirmAction({
        title: t('work.removeSender'),
        message: address,
        confirmLabel: t('work.removeSender'),
        destructive: true,
      }))
    )
      return;
    if (!current()) return;
    const result = await removeSender(id, address);
    if (!current()) return;
    if (!result.ok) alertError(t('work.saveFailed'), undefined, result.message);
    else box.setData(result.data);
  };
  const more = async (screened = false) => {
    const current = screened ? held : list;
    if (!current.data?.next_cursor || busy) return;
    const applies = current.capture();
    setBusy(true);
    const result = await mail(id, current.data.next_cursor, screened ? 'screened' : undefined);
    setBusy(false);
    if (!applies()) return;
    if (result.ok) {
      shown.current[screened ? 'held' : 'all']++;
      current.setData((old) => (old ? { ...result.data, items: [...old.items, ...result.data.items] } : old));
    } else alertError(t('work.loadFailed'), undefined, result.message);
  };
  const row = (item: NonNullable<typeof list.data>['items'][number]) => (
    <ListRow
      key={item.id}
      title={item.subject || t('work.noSubject')}
      subtitle={item.from.name || item.from.address}
      onPress={() => router.push({ pathname: '/agents/mail', params: { id, mail: item.id } })}
      accessory="chevron"
    />
  );
  return (
    <>
      <Stack.Screen options={{ title: t('work.mailbox') }} />
      {!box.data ? (
        <ResourceState error={box.error} loading={box.loading} retry={() => void box.refresh()} />
      ) : !box.data.available ? (
        <ListSection>
          <ListRow title={t(box.data.reason === 'not_configured' ? 'work.notConfigured' : 'work.mailUnavailable')} />
        </ListSection>
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: 40 }}>
          <ListSection>
            <View style={{ padding: space.margin }}>
              <Text selectable style={{ ...typo.body, color: c.label }}>
                {box.data.address}
              </Text>
            </View>
          </ListSection>
          <ListSection header={t('work.senders')}>
            <ListRow title={me?.email ?? ''} value={t('work.alwaysAllowed')} />
            {box.data.allow_members ? <ListRow title={t('work.workspaceMembers')} /> : null}
            {box.data.senders.map((sender) => (
              <NativeMenu
                key={sender.address}
                trigger="longPress"
                items={[{ id: 'remove', title: t('work.removeSender'), destructive: true }]}
                onSelect={() => void remove(sender.address)}
              >
                <ListRow
                  title={sender.address}
                  accessibilityActions={[{ name: 'remove', label: t('work.removeSender') }]}
                  onAccessibilityAction={(e) => {
                    if (e.nativeEvent.actionName === 'remove') void remove(sender.address);
                  }}
                />
              </NativeMenu>
            ))}
            <ListRow title={t('work.addSender')} icon="plus" onPress={() => void add()} />
          </ListSection>
          {list.error ? (
            <ListSection>
              <ListRow title={t('work.loadFailed')} onPress={() => void list.refresh()} />
            </ListSection>
          ) : (
            <>
              <ListSection header={t('work.held')}>
                {held.data?.items.map(row)}
                {held.error ? (
                  <ListRow title={t('work.loadFailed')} onPress={() => void held.refresh()} />
                ) : !held.data?.items.length ? (
                  <ListRow title={t('work.noHeld')} />
                ) : null}
                {held.data?.next_cursor ? <ListRow title={t('work.more')} onPress={() => void more(true)} /> : null}
              </ListSection>
              <ListSection header={t('work.mail')}>
                {list.data?.items.filter((item) => item.status !== 'screened').map(row)}
                {list.data && !list.data.items.some((item) => item.status !== 'screened') ? (
                  <ListRow title={t('work.noMail')} />
                ) : null}
              </ListSection>
            </>
          )}
          {list.data?.next_cursor ? (
            <NativeButton label={t('work.more')} loading={busy} onPress={() => void more()} />
          ) : null}
        </ScrollView>
      )}
    </>
  );
}
