/**
 * `/new-room[?room=<id>]` — a conversation with other people (a room, CONV-04): an optional
 * name, the people (the native search bar filters them), and which of my Agents come along.
 * With `room`: add people (and my Agents) to it. A SwiftUI Form sheet, mounted from the first
 * frame; Android: ./new-room.android.tsx. The behaviour is src/rooms/use-new-room.ts.
 */

import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { Keyboard } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Button, HStack, ProgressView, Section, Spacer, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import { foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { useT } from '../src/lib/i18n';
import { agentHandle, useNewRoom } from '../src/rooms/use-new-room';
import { openConversation } from '../src/shell/nav';
import { useTheme } from '../src/theme';
import { FormCheckRow, NativeForm } from '../src/ui/native-form';
import { FormChrome } from '../src/ui/sheet-chrome';

const SECONDARY = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

export default function NewRoom() {
  const t = useT();
  const { hex } = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const { room } = useLocalSearchParams<{ room?: string }>();
  const adding = !!room;
  const r = useNewRoom(room || null);
  const titleText = useNativeState('');

  // Leaving with the name field focused: the keyboard goes first (a focused field in a Form that
  // goes away throws in UIKit — apps/mobile/AGENTS.md).
  useEffect(() => navigation.addListener('beforeRemove', () => Keyboard.dismiss()), [navigation]);

  const save = async () => {
    const outcome = await r.save();
    if (outcome === null) return;
    if (outcome === true) router.back();
    else openConversation(router, { id: outcome, title: r.title.trim() }, 'dismissTo');
  };
  const latestSave = useRef(save);
  useLayoutEffect(() => {
    latestSave.current = save;
  });

  return (
    <>
      <FormChrome
        title={adding ? t('rooms.addTitle') : t('rooms.newTitle')}
        dirty={r.dirty}
        canSave={r.canSave}
        saving={r.saving}
        saveLabel={adding ? t('rooms.add') : t('rooms.create')}
        onSave={() => void latestSave.current()}
      />
      {r.people?.length ? (
        <Stack.SearchBar
          placeholder={t('directory.search')}
          onChangeText={(e) => r.setQuery(e.nativeEvent.text)}
          onCancelButtonPress={() => r.setQuery('')}
          tintColor={hex.accent}
          autoCapitalize="none"
          hideWhenScrolling={false}
        />
      ) : null}
      <NativeForm>
        {adding ? null : (
          <Section title={t('rooms.name')} footer={<Text>{t('rooms.nameFooter')}</Text>}>
            <TextField text={titleText} placeholder={t('rooms.namePlaceholder')} maxLength={120} onTextChange={r.setTitle} />
          </Section>
        )}
        <Section
          title={t('rooms.people')}
          footer={r.picked.length ? <Text>{t('rooms.picked', { n: r.picked.length })}</Text> : undefined}
        >
          {r.people === null && !r.failed ? (
            <HStack>
              <Spacer />
              <ProgressView />
              <Spacer />
            </HStack>
          ) : r.failed ? (
            <>
              <Text modifiers={[SECONDARY]}>{t('rooms.loadFailed')}</Text>
              <Button systemImage="arrow.clockwise" label={t('common.retry')} onPress={() => void r.reload()} />
            </>
          ) : r.rows.length === 0 ? (
            <Text modifiers={[SECONDARY]}>{r.query ? t('directory.noMatches') : t('rooms.noPeople')}</Text>
          ) : (
            r.rows.map((person) => (
              <FormCheckRow
                key={person.id}
                label={person.name}
                detail={person.email}
                systemImage="person.crop.circle.fill"
                systemImageColor={hex.accent}
                checked={r.picked.includes(person.id)}
                onPress={() => r.toggle(person.id)}
              />
            ))
          )}
        </Section>
        {r.myAgents.length ? (
          <Section title={t('rooms.agents')} footer={<Text>{t('rooms.agentsFooter')}</Text>}>
            {r.myAgents.map((agent) => (
              <FormCheckRow
                key={agent.id}
                label={agent.name}
                detail={agent.role.trim() || undefined}
                systemImage="leaf"
                systemImageColor={hex.green}
                checked={r.bring.includes(agentHandle(agent))}
                onPress={() => r.toggleAgent(agentHandle(agent))}
              />
            ))}
          </Section>
        ) : null}
      </NativeForm>
    </>
  );
}
