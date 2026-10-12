/**
 * `/bots/new-room[?room=<sid>]` — a conversation with other people (a room, spec
 * docs/specs/20261011-agent-first-class.md §5d P5). From the drawer: the 同事 section's "New
 * Conversation With People", or the ✎ button's long press. A SwiftUI Form sheet (Android has no
 * Agents: ./new-room.android.tsx). Rules in src/bots/rooms.ts (`peopleRows`, `createRoomInput`).
 *
 *  - New: an optional title, the people (who can be in one: `GET /api/rooms/people` — active
 *    teammates with Agents on; the native search bar filters by name or email), and any of the
 *    member's own Agents. ✓ (enabled once someone is picked) → `POST /api/rooms` → the sheet closes
 *    onto the thread (`/?c=`). One person, no title, no Agents is the pair's private chat: an
 *    existing one opens again instead of a second.
 *  - `?room=`: Add People — only the people list (those not in it yet); ✓ adds them one by one
 *    (`POST /api/rooms/:id/participants`) and closes; the thread hears it on the socket.
 *
 * Refusals are the server's (`alertError` with its sentence): someone who can't join (400), a full
 * room (409 `room_full`). The Form is mounted from the first frame (loading is a row inside it).
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Button, HStack, ProgressView, Section, Spacer, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import { foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { addRoomPerson } from '../../src/api/bots';
import { openThread } from '../../src/bots/nav';
import { createRoomInput, peopleRows, personTint } from '../../src/bots/rooms';
import { BotsRouteGate } from '../../src/bots/route-gate';
import { useBots } from '../../src/bots/store';
import { rowTitle } from '../../src/bots/drawer/row-text';
import { useRowCopy } from '../../src/bots/drawer/conversation-row';
import { useT } from '../../src/lib/i18n';
import { useTheme } from '../../src/theme';
import { alertError } from '../../src/ui/dialogs';
import { FormCheckRow, NativeForm } from '../../src/ui/native-form';
import { FormChrome } from '../../src/ui/sheet-chrome';

const SECONDARY = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

/** Closed Agents → home + "unavailable" (src/bots/route-gate.tsx; latched, as every SwiftUI sheet). */
export default function NewRoomRoute() {
  return (
    <BotsRouteGate kind="threads" latched>
      <NewRoomSheet />
    </BotsRouteGate>
  );
}

function NewRoomSheet() {
  const t = useT();
  const { hex } = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const { room: roomId } = useLocalSearchParams<{ room?: string }>();
  const adding = !!roomId;

  const people = useBots((s) => s.people);
  const state = useBots((s) => s.peopleState);
  const ownBots = useBots((s) => s.bots);
  const room = useBots((s) => (roomId ? (s.conversations.find((row) => row.session_id === roomId) ?? null) : null));
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const titleText = useNativeState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void useBots.getState().loadPeople();
  }, []);
  // Leaving with the title field focused: the keyboard goes first (a focused field in a Form that
  // goes away throws in UIKit — apps/mobile/AGENTS.md).
  useEffect(() => navigation.addListener('beforeRemove', () => Keyboard.dismiss()), [navigation]);

  // Who is in the room already (Add People) — never offered again.
  const inRoom = useMemo(() => new Set((room?.participants ?? []).map((person) => person.user_id)), [room]);
  const rows = useMemo(() => peopleRows(people, query, inRoom), [people, query, inRoom]);
  const everyoneIn = adding && state === 'loaded' && people.length > 0 && peopleRows(people, '', inRoom).length === 0;
  const myAgents = useMemo(() => ownBots.filter((bot) => bot.status === 'active'), [ownBots]);

  const toggle = useCallback(
    (id: string) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])),
    [],
  );
  const toggleAgent = useCallback(
    (id: string) => setAgents((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])),
    [],
  );

  const copy = useRowCopy();
  const save = async () => {
    if (saving || picked.length === 0) return;
    setSaving(true);
    if (roomId) {
      // One by one: the server announces each newcomer with its own line.
      for (const id of picked) {
        const result = await addRoomPerson(roomId, id);
        if (result.ok) continue;
        setSaving(false);
        const name = people.find((person) => person.id === id)?.nickname ?? '';
        alertError(
          result.code === 'room_full' ? t('bots.room.full') : t('bots.room.addFailed', { name }),
          result.code === 'room_full' ? undefined : result.message || undefined,
        );
        setPicked((list) => list.slice(list.indexOf(id)));
        void useBots.getState().loadConversations();
        return;
      }
      void useBots.getState().loadConversations();
      router.back();
      return;
    }
    const result = await useBots
      .getState()
      .createRoom(createRoomInput({ people: picked, title: titleText.get(), agents }));
    setSaving(false);
    if (!result.ok) {
      alertError(
        result.code === 'room_full' ? t('bots.room.full') : t('bots.room.createFailed'),
        result.code === 'room_full' ? undefined : result.message || undefined,
      );
      return;
    }
    const title = rowTitle(result.conversation, useBots.getState(), copy);
    openThread(router, { c: result.conversation.session_id, title }, 'dismissTo');
  };
  const latestSave = useRef(save);
  useLayoutEffect(() => {
    latestSave.current = save;
  });

  const loaded = state === 'loaded';
  const dirty = picked.length > 0 || agents.length > 0 || !!title.trim();
  return (
    <>
      <FormChrome
        title={adding ? t('bots.room.addTitle') : t('bots.room.newTitle')}
        dirty={dirty}
        canSave={picked.length > 0}
        saving={saving}
        saveLabel={adding ? t('bots.room.add') : t('bots.room.start')}
        onSave={() => void latestSave.current()}
      />
      {loaded && people.length > 0 && !everyoneIn ? (
        <Stack.SearchBar
          placeholder={t('drawer.search')}
          onChangeText={(e) => setQuery(e.nativeEvent.text)}
          onCancelButtonPress={() => setQuery('')}
          tintColor={hex.accent}
          autoCapitalize="none"
          hideWhenScrolling={false}
        />
      ) : null}
      <NativeForm>
        {adding ? null : (
          <Section title={t('bots.room.titleSection')} footer={<Text>{t('bots.room.titleFooter')}</Text>}>
            <TextField
              text={titleText}
              placeholder={t('bots.room.titlePlaceholder')}
              maxLength={200}
              onTextChange={setTitle}
            />
          </Section>
        )}

        <Section
          title={t('bots.room.people')}
          footer={picked.length > 0 ? <Text>{t('bots.room.picked', { n: picked.length })}</Text> : undefined}
        >
          {state === 'idle' ? (
            <HStack>
              <Spacer />
              <ProgressView />
              <Spacer />
            </HStack>
          ) : state === 'failed' && people.length === 0 ? (
            <>
              <Text modifiers={[SECONDARY]}>{t('bots.room.loadFailed')}</Text>
              <Button
                systemImage="arrow.clockwise"
                label={t('common.retry')}
                onPress={() => void useBots.getState().loadPeople()}
              />
            </>
          ) : state === 'missing' ? (
            <Text modifiers={[SECONDARY]}>{t('bots.room.missingHint')}</Text>
          ) : people.length === 0 ? (
            <Text modifiers={[SECONDARY]}>{t('bots.room.noPeopleHint')}</Text>
          ) : everyoneIn ? (
            <Text modifiers={[SECONDARY]}>{t('bots.room.everyoneIn')}</Text>
          ) : rows.length === 0 ? (
            <Text modifiers={[SECONDARY]}>{t('bots.room.noMatch')}</Text>
          ) : (
            rows.map((person) => (
              <FormCheckRow
                key={person.id}
                label={person.nickname}
                detail={person.email !== person.nickname ? person.email : undefined}
                systemImage="person.crop.circle.fill"
                systemImageColor={hex[personTint(person.id)]}
                checked={picked.includes(person.id)}
                onPress={() => toggle(person.id)}
              />
            ))
          )}
        </Section>

        {adding || myAgents.length === 0 ? null : (
          <Section title={t('bots.room.agents')} footer={<Text>{t('bots.room.agentsFooter')}</Text>}>
            {myAgents.map((bot) => (
              <FormCheckRow
                key={bot.id}
                label={bot.name}
                detail={bot.role.trim() || undefined}
                systemImage="leaf"
                systemImageColor={hex.accent}
                checked={agents.includes(bot.id)}
                onPress={() => toggleAgent(bot.id)}
              />
            ))}
          </Section>
        )}
      </NativeForm>
    </>
  );
}
