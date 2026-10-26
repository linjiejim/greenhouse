import React from 'react';
import { Text } from 'react-native';
import { useStations } from '../store/stations';
import { NativeForm, FormNavRow } from '../ui/native-form.web';
import { useT } from '../lib/i18n';
export function StationsForm(_props: { onDone: () => void; onLeave: () => void }) {
  const active = useStations((s) => s.stations[0]);
  const t = useT();
  return (
    <NativeForm>
      <FormNavRow label={active?.name ?? ''} value={active?.baseUrl} onPress={() => {}} />
      <Text>{t('station.lockedHint', { name: active?.name ?? '' })}</Text>
    </NativeForm>
  );
}
export function StationAddForm(props: { onLeave: () => void }) {
  return <StationsForm onDone={props.onLeave} onLeave={props.onLeave} />;
}
