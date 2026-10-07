/**
 * StationsForm — the body of the stations screen (saved Greenhouse servers),
 * shared by the login screen's sheet (/sheets/stations) and the pushed
 * Settings page (/settings/stations). The behaviour is the shared
 * ./use-stations-form.ts; this is the iOS view (Android:
 * ./stations-form.android.tsx). A real SwiftUI Form:
 *
 *  - one row per station (name + origin, ✓ on the active one); tap switches,
 *    swipe left or touch-and-hold for 移除 (system swipe actions / context
 *    menu, confirmed with a destructive alert),
 *  - an 添加工作站 section: address + optional name fields, validated with
 *    `normalizeBaseUrl` and probed (`probeStation`: is there a Greenhouse API?)
 *    before saving, with an inline progress state; a failure is a system alert
 *    (`alertError`: 无法添加工作站 + the reason).
 *
 * Rows are the shared `FormCheckRow` (server symbol, name, origin, ✓ active).
 *
 * Every change of the active station re-runs `auth.bootstrap()` (rehydrates
 * that station's tokens and revalidates; the root layout then routes home or
 * to /login). The host is dismissed *first* (`onLeave`) so the reroute never
 * happens under a presented sheet.
 *
 * Single-station builds (IS_SINGLE_STATION) show only the locked station,
 * with no add / remove, and a footer explaining the lock.
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  Button,
  ContextMenu,
  HStack,
  ProgressView,
  Section,
  SwipeActions,
  Text,
  TextField,
  useNativeState,
  type TextFieldRef,
} from '@expo/ui/swift-ui';
import {
  autocorrectionDisabled,
  disabled,
  foregroundStyle,
  keyboardType,
  onSubmit,
  submitLabel,
  textContentType,
  textInputAutocapitalization,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import type { StationRecord } from '../store/stations';
import { useT } from '../lib/i18n';
import { useTheme } from '../theme';
import { FormCheckRow, NativeForm } from '../ui/native-form';
import { useStationsForm } from './use-stations-form';

export function StationsForm({ onDone, onLeave }: {
  /** Nothing changed (the active station was tapped) — just close / go back. */
  onDone: () => void;
  /** The active station is about to change — dismiss whatever hosts this form. */
  onLeave: () => void;
}) {
  const t = useT();
  const { stations, activeId, active, locked, busy, select, remove, add: addStation } = useStationsForm({ onDone, onLeave });

  // The native fields own the text (`url` mirrors it to enable 添加); onTextChange
  // is async, so submitting reads the native values.
  const urlState = useNativeState('');
  const nameState = useNativeState('');
  const nameRef = useRef<TextFieldRef>(null);
  const [url, setUrl] = useState('');
  const add = useCallback(
    () => addStation(urlState.get() ?? url, nameState.get() ?? ''),
    [addStation, urlState, nameState, url],
  );

  const canAdd = !busy && !!url.trim();

  return (
    <NativeForm>
      <Section
        footer={<Text>{locked ? t('station.lockedHint', { name: active?.name ?? '' }) : t('station.hint')}</Text>}
      >
        {stations.length === 0 ? (
          <Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>{t('station.empty')}</Text>
        ) : (
          stations.map((station) => (
            <StationRow
              key={station.id}
              station={station}
              active={station.id === activeId}
              locked={locked}
              onPress={() => select(station)}
              onRemove={() => void remove(station)}
            />
          ))
        )}
      </Section>

      {!locked ? (
        <Section title={t('station.add')} footer={<Text>{t('station.addHint')}</Text>}>
          <TextField
            text={urlState}
            placeholder={t('station.urlPlaceholder')}
            onTextChange={setUrl}
            modifiers={[
              keyboardType('url'),
              textContentType('URL'),
              textInputAutocapitalization('never'),
              autocorrectionDisabled(),
              submitLabel('next'),
              onSubmit(() => void nameRef.current?.focus()),
              disabled(busy),
            ]}
          />
          <TextField
            ref={nameRef}
            text={nameState}
            placeholder={t('station.namePlaceholder')}
            modifiers={[submitLabel('go'), onSubmit(() => void add()), disabled(busy)]}
          />
          <Button onPress={() => void add()} modifiers={[disabled(!canAdd)]}>
            {busy ? (
              <HStack spacing={8}>
                <ProgressView />
                <Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>{t('station.checking')}</Text>
              </HStack>
            ) : (
              <Text>{t('station.addAction')}</Text>
            )}
          </Button>
        </Section>
      ) : null}
    </NativeForm>
  );
}

function StationRow({
  station,
  active,
  locked,
  onPress,
  onRemove,
}: {
  station: StationRecord;
  active: boolean;
  locked: boolean;
  onPress: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const { hex } = useTheme();
  const row = (
    <FormCheckRow label={station.name} detail={station.baseUrl} systemImage="server.rack" checked={active} onPress={onPress} />
  );
  if (locked) return row;
  return (
    <SwipeActions>
      <ContextMenu>
        <ContextMenu.Trigger>{row}</ContextMenu.Trigger>
        <ContextMenu.Items>
          <Button role="destructive" systemImage="trash" label={t('station.delete')} onPress={onRemove} />
        </ContextMenu.Items>
      </ContextMenu>
      {/* not role="destructive": that animates the row away before the confirm alert */}
      <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
        <Button systemImage="trash" label={t('station.delete')} onPress={onRemove} modifiers={[tint(hex.red)]} />
      </SwipeActions.Actions>
    </SwipeActions>
  );
}
