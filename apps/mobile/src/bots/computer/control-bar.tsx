/**
 * Under the screen: watching → "Take Over" (+ zoom); in control → the helper
 * keys, how long the member has held it, "Type" (native text input → the
 * focused field of the computer's browser, IME and pasted text included) and
 * "Hand Back".
 */

import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useT, type TranslationKey } from '../../lib/i18n';
import { makeStyles, radius, space, typo, useTheme, weight } from '../../theme';
import { NativeButton } from '../../ui/button';
import { Icon, Touchable, type IconName } from '../../ui/core';
import { heldFor } from './model';
import type { HelperKey } from './viewer-html';

const KEYS: ReadonlyArray<[HelperKey, TranslationKey]> = [
  ['escape', 'bots.computer.keyEscape'],
  ['tab', 'bots.computer.keyTab'],
  ['backspace', 'bots.computer.keyBackspace'],
  ['enter', 'bots.computer.keyEnter'],
  ['pageUp', 'bots.computer.keyPageUp'],
  ['pageDown', 'bots.computer.keyPageDown'],
];

function IconButton({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Touchable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={styles.iconButton} hitSlop={6}>
      <Icon name={icon} size={17} color={c.label} />
    </Touchable>
  );
}

export function ControlBar({
  inControl,
  since,
  busy,
  bottomInset,
  onTakeOver,
  onHandBack,
  onType,
  onKey,
  onZoom,
}: {
  inControl: boolean;
  /** When the member took the computer (ISO). */
  since: string | null;
  busy: 'takeover' | 'handback' | 'type' | null;
  bottomInset: number;
  onTakeOver: () => void;
  onHandBack: () => void;
  onType: () => void;
  onKey: (key: HelperKey) => void;
  onZoom: (to: 'fit' | 'in' | 'out') => void;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!inControl) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [inControl]);

  const zoom = (
    <View style={styles.zoom}>
      <IconButton icon="zoomOut" label={t('bots.computer.zoomOut')} onPress={() => onZoom('out')} />
      <IconButton icon="expand" label={t('bots.computer.zoomFit')} onPress={() => onZoom('fit')} />
      <IconButton icon="zoomIn" label={t('bots.computer.zoomIn')} onPress={() => onZoom('in')} />
    </View>
  );

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(bottomInset, space.md) }]}>
      {inControl ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.keys}>
            {KEYS.map(([key, label]) => (
              <Touchable
                key={key}
                onPress={() => onKey(key)}
                haptic="light"
                accessibilityRole="button"
                style={styles.key}
              >
                <Text style={styles.keyText}>{t(label)}</Text>
              </Touchable>
            ))}
          </ScrollView>
          <View style={styles.row}>
            <Text style={styles.held} numberOfLines={1}>
              {t('bots.computer.inControlFor', { time: heldFor(since, now) })}
            </Text>
            {zoom}
          </View>
          <View style={styles.row}>
            <View style={styles.half}>
              <NativeButton
                label={t('bots.computer.type')}
                icon="keyboard"
                size="large"
                fullWidth
                loading={busy === 'type'}
                disabled={busy !== null && busy !== 'type'}
                onPress={onType}
              />
            </View>
            <View style={styles.half}>
              <NativeButton
                label={t('bots.computer.handBack')}
                icon="hand"
                variant="prominent"
                size="large"
                fullWidth
                loading={busy === 'handback'}
                disabled={busy !== null && busy !== 'handback'}
                onPress={onHandBack}
              />
            </View>
          </View>
        </>
      ) : (
        <>
          <View style={styles.row}>
            <Text style={styles.hint} numberOfLines={2}>
              {t('bots.computer.watchHint')}
            </Text>
            {zoom}
          </View>
          <NativeButton
            label={t('bots.computer.takeOver')}
            icon="hand"
            variant="prominent"
            size="large"
            fullWidth
            loading={busy === 'takeover'}
            onPress={onTakeOver}
            testID="computer-take-over"
          />
        </>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  bar: {
    gap: space.md,
    paddingTop: space.md,
    paddingHorizontal: space.margin,
    backgroundColor: c.background,
    borderTopWidth: 0.5,
    borderTopColor: c.separator,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  half: { flex: 1 },
  keys: { gap: space.sm },
  key: {
    minWidth: 52,
    height: 34,
    paddingHorizontal: space.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: c.tertiaryFill,
  },
  keyText: { ...typo.subheadline, fontWeight: weight.medium, color: c.label },
  held: { ...typo.footnote, color: c.accentText, fontWeight: weight.semibold, flex: 1 },
  hint: { ...typo.footnote, color: c.secondaryLabel, flex: 1 },
  zoom: { flexDirection: 'row', gap: space.xs },
  iconButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: c.tertiaryFill,
  },
}));
