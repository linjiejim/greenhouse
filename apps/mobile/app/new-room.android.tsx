/**
 * `/new-room[?room=<id>]` on Android (iOS: ./new-room.tsx; both read src/rooms/use-new-room.ts):
 * a Material form — the name, a search field, the people and my Agents as check rows.
 */

import React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useT } from '../src/lib/i18n';
import { agentHandle, useNewRoom } from '../src/rooms/use-new-room';
import { openConversation } from '../src/shell/nav';
import {
  FormActionRow,
  FormFields,
  FormSection,
  FormSwitchRow,
  FormTextField,
  FormValueRow,
  NativeForm,
  FormLoading,
  useNativeState,
} from '../src/ui/native-form.android';
import { FormChrome } from '../src/ui/sheet-chrome';

export default function NewRoom() {
  const t = useT();
  const router = useRouter();
  const { room } = useLocalSearchParams<{ room?: string }>();
  const adding = !!room;
  const r = useNewRoom(room || null);
  const titleText = useNativeState('');
  const searchText = useNativeState('');

  const save = async () => {
    const outcome = await r.save();
    if (outcome === null) return;
    if (outcome === true) router.back();
    else openConversation(router, { id: outcome, title: r.title.trim() }, 'dismissTo');
  };

  return (
    <>
      <FormChrome
        title={adding ? t('rooms.addTitle') : t('rooms.newTitle')}
        dirty={r.dirty}
        canSave={r.canSave}
        saving={r.saving}
        saveLabel={adding ? t('rooms.add') : t('rooms.create')}
        onSave={() => void save()}
      />
      <NativeForm>
        <FormFields>
          {adding ? null : (
            <FormTextField
              label={t('rooms.name')}
              state={titleText}
              onChangeText={r.setTitle}
              placeholder={t('rooms.namePlaceholder')}
              supporting={t('rooms.nameFooter')}
            />
          )}
          <FormTextField
            label={t('directory.search')}
            state={searchText}
            onChangeText={r.setQuery}
            imeAction="search"
          />
        </FormFields>
        <FormSection
          title={t('rooms.people')}
          footer={r.picked.length ? t('rooms.picked', { n: r.picked.length }) : undefined}
        >
          {r.people === null && !r.failed ? (
            <FormLoading />
          ) : r.failed ? (
            <FormActionRow label={t('common.retry')} icon="refresh" onPress={() => void r.reload()} />
          ) : r.rows.length === 0 ? (
            <FormValueRow label={r.query ? t('directory.noMatches') : t('rooms.noPeople')} value="" />
          ) : (
            r.rows.map((person) => (
              <FormSwitchRow
                key={person.id}
                label={person.name}
                detail={person.email}
                value={r.picked.includes(person.id)}
                onValueChange={() => r.toggle(person.id)}
              />
            ))
          )}
        </FormSection>
        {r.myAgents.length ? (
          <FormSection title={t('rooms.agents')} footer={t('rooms.agentsFooter')}>
            {r.myAgents.map((agent) => (
              <FormSwitchRow
                key={agent.id}
                label={agent.name}
                detail={agent.role.trim() || undefined}
                value={r.bring.includes(agentHandle(agent))}
                onValueChange={() => r.toggleAgent(agentHandle(agent))}
              />
            ))}
          </FormSection>
        ) : null}
      </NativeForm>
    </>
  );
}
