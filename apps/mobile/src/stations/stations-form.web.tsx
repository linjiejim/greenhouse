import React, { useState } from 'react';
import { Text } from 'react-native';
import { NativeForm, FormNavRow, FormCheckRow } from '../ui/native-form.web';
import { useStationsForm } from './use-stations-form';
import { useT } from '../lib/i18n';
export function StationsForm(props: { onDone: () => void; onLeave: () => void }) {
  const form = useStationsForm(props),
    t = useT();
  return (
    <NativeForm>
      {form.locked ? (
        <>
          <FormNavRow label={form.active?.name ?? ''} value={form.active?.baseUrl} onPress={() => {}} />
          <Text>{t('station.lockedHint', { name: form.active?.name ?? '' })}</Text>
        </>
      ) : (
        <>
          {form.stations.map((station) => (
            <div key={station.id}>
              <FormCheckRow
                label={station.name}
                detail={station.baseUrl}
                checked={station.id === form.activeId}
                choice="single"
                onPress={() => {
                  if (!form.busy) void form.select(station);
                }}
              />
              <button disabled={form.busy} onClick={() => void form.remove(station)}>
                {t('station.delete')}
              </button>
            </div>
          ))}
          <StationAddForm onLeave={props.onLeave} />
        </>
      )}
    </NativeForm>
  );
}
export function StationAddForm({ onLeave }: { onLeave: () => void }) {
  const form = useStationsForm({ onDone: onLeave, onLeave }),
    t = useT();
  const [url, setUrl] = useState(''),
    [name, setName] = useState('');
  if (form.locked) return <Text>{t('station.lockedHint', { name: form.active?.name ?? '' })}</Text>;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.add(url, name);
      }}
      style={{ display: 'grid', gap: 12 }}
    >
      <label>
        {t('station.urlLabel')}
        <input
          type="text"
          inputMode="url"
          required
          aria-label={t('station.urlLabel')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={form.busy}
          placeholder={t('station.urlPlaceholder')}
        />
      </label>
      <label>
        {t('station.namePlaceholder')}
        <input
          aria-label={t('station.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={form.busy}
        />
      </label>
      <button disabled={form.busy || !url.trim()} type="submit">
        {form.busy ? t('common.loading') : t('station.addAction')}
      </button>
    </form>
  );
}
