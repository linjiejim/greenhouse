/**
 * StationsForm on Android — a Material 3 form over the shared behaviour
 * (./use-stations-form.ts; iOS view: ./stations-form.tsx). Same props, same
 * hosts (the login sheet and Settings → 工作站):
 *
 *  - the saved stations as a single-choice list (radio button on the active
 *    one; tap switches, long-press removes — confirmed),
 *  - 添加工作站: outlined address + optional name fields and the 添加 button
 *    (a progress indicator while the server is probed).
 */

import React, { useState } from 'react';
import { Button, CircularProgressIndicator, Column, Text } from '@expo/ui/jetpack-compose';
import { fillMaxWidth, padding, size } from '@expo/ui/jetpack-compose/modifiers';
import { useT } from '../lib/i18n';
import { FormCheckRow, FormSection, FormValueRow, NativeForm, FormTextField, useNativeState } from '../ui/native-form.android';
import { useStationsForm } from './use-stations-form';

export function StationsForm({ onDone, onLeave }: {
  /** Nothing changed (the active station was tapped) — just close / go back. */
  onDone: () => void;
  /** The active station is about to change — dismiss whatever hosts this form. */
  onLeave: () => void;
}) {
  const t = useT();
  const { stations, activeId, active, locked, busy, select, remove, add } = useStationsForm({ onDone, onLeave });
  const urlState = useNativeState('');
  const nameState = useNativeState('');
  const [url, setUrl] = useState('');
  const submit = () => void add(urlState.get() ?? url, nameState.get() ?? '');

  return (
    <NativeForm>
      <FormSection
        footer={locked ? t('station.lockedHint', { name: active?.name ?? '' }) : t('station.hintAndroid')}
      >
        {stations.length === 0 ? (
          <FormValueRow label={t('station.empty')} />
        ) : (
          stations.map((station) => (
            <FormCheckRow
              key={station.id}
              label={station.name}
              detail={station.baseUrl}
              icon="server"
              checked={station.id === activeId}
              onPress={() => select(station)}
              onLongPress={locked ? undefined : () => void remove(station)}
            />
          ))
        )}
      </FormSection>

      {!locked ? (
        <FormSection title={t('station.add')} footer={t('station.addHint')}>
          <Column verticalArrangement={{ spacedBy: 12 }} modifiers={[fillMaxWidth(), padding(16, 16, 16, 16)]}>
            <FormTextField
              label={t('station.urlLabel')}
              placeholder={t('station.urlPlaceholder')}
              state={urlState}
              onChangeText={setUrl}
              keyboard="uri"
              imeAction="next"
              enabled={!busy}
            />
            <FormTextField
              label={t('station.namePlaceholder')}
              state={nameState}
              imeAction="go"
              onSubmit={submit}
              enabled={!busy}
            />
            <Button onClick={submit} enabled={!busy && !!url.trim()} modifiers={[fillMaxWidth()]}>
              {busy ? (
                <CircularProgressIndicator modifiers={[size(18, 18)]} />
              ) : (
                <Text style={{ typography: 'labelLarge' }}>{t('station.addAction')}</Text>
              )}
            </Button>
          </Column>
        </FormSection>
      ) : null}
    </NativeForm>
  );
}
