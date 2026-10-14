/**
 * `/room-people?c=<room>` — who is in a room (CONV-04): its people (the owner marked) and the
 * Agents they brought (whose). Add people; the owner removes someone (touch and hold) — their
 * Agents leave with them. A sheet with plain lists (both platforms).
 */

import React, { useEffect } from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { removeMember } from '../src/api/conversations';
import { useT } from '../src/lib/i18n';
import { useAuth } from '../src/store/auth';
import { useThreads } from '../src/store/threads';
import { space } from '../src/theme';
import { AgentAvatar, MemberAvatar } from '../src/ui/agent-avatar';
import { alertError, confirmAction } from '../src/ui/dialogs';
import { LoadingState } from '../src/ui/empty';
import { ListRow, ListSection } from '../src/ui/list';
import { NativeMenu } from '../src/ui/menu';
import { SheetClose } from '../src/ui/sheet-chrome';
import { toolbarIcon } from '../src/ui/toolbar-icon';

export default function RoomPeople() {
  const { c = '' } = useLocalSearchParams<{ c?: string }>();
  const t = useT();
  const router = useRouter();
  const me = useAuth((s) => s.user);
  const members = useThreads((s) => s.threads[c]?.members ?? null);

  useEffect(() => {
    void useThreads.getState().refreshMembers(c);
  }, [c]);

  const owner = members?.members.find((person) => person.role === 'owner')?.id;
  const mineToManage = owner === me?.id;

  const remove = async (id: string, name: string) => {
    const ok = await confirmAction({
      title: t('rooms.removeTitle', { name }),
      confirmLabel: t('rooms.remove'),
      destructive: true,
    });
    if (!ok) return;
    const result = await removeMember(c, id);
    if (!result.ok) alertError(t('rooms.removeFailed'), result.message || undefined);
    void useThreads.getState().refreshMembers(c);
  };

  return (
    <>
      <Stack.Screen options={{ title: t('conversation.people') }} />
      <SheetClose />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('userPlus')}
          accessibilityLabel={t('conversation.addPeople')}
          onPress={() => router.push({ pathname: '/new-room', params: { room: c } })}
        />
      </Stack.Toolbar>
      {!members ? (
        <LoadingState />
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }}>
          <ListSection header={t('rooms.people')}>
            {members.members.map((person) => {
              const row = (
                <ListRow
                  key={person.id}
                  title={person.id === me?.id ? t('rooms.you', { name: person.name }) : person.name}
                  subtitle={person.role === 'owner' ? t('rooms.owner') : person.email}
                  leading={<MemberAvatar name={person.name} url={person.avatar_url} size={30} />}
                  leadingWidth={30}
                />
              );
              return mineToManage && person.id !== me?.id ? (
                <NativeMenu
                  key={person.id}
                  trigger="longPress"
                  items={[{ id: 'remove', title: t('rooms.remove'), icon: 'personMinus', destructive: true }]}
                  onSelect={() => void remove(person.id, person.name)}
                >
                  {row}
                </NativeMenu>
              ) : (
                row
              );
            })}
          </ListSection>
          {members.agents.length ? (
            <ListSection header={t('rooms.agents')}>
              {members.agents.map((agent) => {
                const ownerName = members.members.find((person) => person.id === agent.owner_id)?.name ?? '';
                return (
                  <ListRow
                    key={agent.id}
                    title={agent.name}
                    subtitle={[agent.role, ownerName ? t('rooms.agentOf', { name: ownerName }) : ''].filter(Boolean).join(' · ')}
                    leading={<AgentAvatar agent={{ id: agent.id, avatar: agent.avatar, template_key: null }} size={30} />}
                    leadingWidth={30}
                  />
                );
              })}
            </ListSection>
          ) : null}
        </ScrollView>
      )}
    </>
  );
}
