/**
 * StationSheet — manage the saved Greenhouse servers (stations) and switch the
 * active one. Hosted by the login screen (pick/add before signing in) and by
 * Settings (switch after signing in). Every mutation re-runs auth.bootstrap()
 * so the active station's tokens are rehydrated and the root layout routes to
 * home or /login depending on whether the target station has a live session.
 */

import React, { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { useStations, normalizeBaseUrl, probeStation, type StationRecord } from '../store/stations';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { BottomSheetScrollView, BottomSheetTextInput, Icon, Sheet, Tile, Touchable, useSheetEndReveal } from '../ui';
import { font, makeStyles, radius, useTheme } from '../theme';

export function StationSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const stations = useStations((s) => s.stations);
  const activeId = useStations((s) => s.activeId);

  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { scrollRef, revealEnd } = useSheetEndReveal();

  async function switchTo(station: StationRecord) {
    if (station.id !== activeId) {
      await useStations.getState().switchTo(station.id);
      void useAuth.getState().bootstrap();
    }
    onClose();
  }

  function confirmRemove(station: StationRecord) {
    Alert.alert(t('station.deleteTitle'), t('station.deleteHint', { name: station.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('station.delete'),
        style: 'destructive',
        onPress: () => {
          const wasActive = station.id === activeId;
          void useStations
            .getState()
            .remove(station.id)
            .then(() => {
              if (wasActive) void useAuth.getState().bootstrap();
            });
        },
      },
    ]);
  }

  async function add() {
    const baseUrl = normalizeBaseUrl(url);
    if (!baseUrl) {
      setError(t('station.invalidUrl'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const probe = await probeStation(baseUrl);
      if (!probe.ok) {
        setError(t('station.unreachable'));
        return;
      }
      if (probe.authEnabled === false) {
        setError(t('station.authDisabled'));
        return;
      }
      await useStations.getState().add(baseUrl);
      void useAuth.getState().bootstrap();
      setUrl('');
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title={t('station.title')} heightPct={70}>
      <BottomSheetScrollView
        ref={scrollRef}
        contentContainerStyle={{ padding: 16, paddingBottom: 36 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.hint}>{t('station.hint')}</Text>

        {stations.length === 0 ? <Text style={styles.empty}>{t('station.empty')}</Text> : null}

        {stations.map((station) => {
          const active = station.id === activeId;
          return (
            <Touchable
              key={station.id}
              haptic="selection"
              onPress={() => void switchTo(station)}
              pressedStyle={{ opacity: 0.7 }}
              style={[styles.row, active && styles.rowActive]}
            >
              <Tile icon="server" tint={active ? 'accent' : 'muted'} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {station.name}
                </Text>
                <Text numberOfLines={1} style={styles.rowUrl}>
                  {station.baseUrl}
                </Text>
              </View>
              {active ? <Icon name="check" size={18} color={c.accent} sw={2.4} /> : null}
              <Touchable haptic="none" onPress={() => confirmRemove(station)} hitSlop={8} style={styles.iconBtn}>
                <Icon name="trash" size={16} color={c.fgMuted} />
              </Touchable>
            </Touchable>
          );
        })}

        <View style={styles.divider} />

        <Text style={styles.formLabel}>{t('station.add')}</Text>
        <View style={styles.field}>
          <Icon name="globe" size={17} color={c.fgMuted} />
          <BottomSheetTextInput
            value={url}
            onChangeText={(v: string) => {
              setUrl(v);
              setError(null);
            }}
            onFocus={revealEnd}
            placeholder={t('station.urlPlaceholder')}
            placeholderTextColor={c.fgFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!busy}
            onSubmitEditing={() => void add()}
            style={styles.fieldInput}
          />
        </View>
        {error ? <Text style={styles.err}>{error}</Text> : null}
        <Touchable
          onPress={() => void add()}
          disabled={busy || !url.trim()}
          style={[styles.addBtn, (busy || !url.trim()) && styles.disabled]}
        >
          <Text style={styles.addBtnText}>{busy ? t('station.checking') : t('station.addAction')}</Text>
        </Touchable>
      </BottomSheetScrollView>
    </Sheet>
  );
}

/** Active station record (reactive) — for trigger rows in login/settings. */
export function useActiveStation(): StationRecord | null {
  const stations = useStations((s) => s.stations);
  const activeId = useStations((s) => s.activeId);
  return stations.find((s) => s.id === activeId) ?? null;
}

const useStyles = makeStyles((c) => ({
  hint: { fontSize: font.caption, color: c.fgMuted, marginBottom: 12 },
  empty: { fontSize: font.small, color: c.fgFaint, textAlign: 'center', paddingVertical: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.hairline,
    padding: 13,
    marginBottom: 10,
  },
  rowActive: { borderColor: c.accentBorder, backgroundColor: c.accentTint },
  rowTitle: { fontSize: font.body, fontWeight: '600', color: c.fg },
  rowUrl: { fontSize: font.caption, color: c.fgMuted, marginTop: 3 },
  iconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },

  divider: { height: 1, backgroundColor: c.hairline, marginVertical: 16 },
  formLabel: { fontSize: font.caption, fontWeight: '600', color: c.fgMuted, marginBottom: 8 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.hairline,
    paddingHorizontal: 14,
    height: 48,
  },
  fieldInput: { flex: 1, fontSize: font.body, color: c.fg, padding: 0 },
  err: { color: c.danger, fontSize: font.small, marginTop: 8, paddingLeft: 2 },
  addBtn: {
    marginTop: 12,
    backgroundColor: c.accent,
    borderRadius: radius.lg,
    paddingVertical: 13,
    alignItems: 'center',
  },
  addBtnText: { fontSize: font.body, fontWeight: '600', color: c.onAccent },
  disabled: { opacity: 0.5 },
}));
