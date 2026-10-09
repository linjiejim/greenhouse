/**
 * Hand-off sheet (form sheet, native header) — the whole brief one Bot passed
 * to another, opened from the hand-off strip in a thread (src/bots/thread/rows/handoff-row.tsx).
 * The strip stays one line in the transcript; here the brief reads as written
 * — markdown, since Bots brief each other in lists and bold. Payload
 * `{ from, to, fromName, toName, brief }` arrives via the handoff store
 * (`?k=`, kind `relay`); a missing key renders the "no longer available" state.
 */

import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import type { RelayPayload } from '../../src/bots/thread/rows/handoff-row';
import { BotAvatar } from '../../src/bots/ui/bot-avatar';
import { Markdown } from '../../src/chat/markdown';
import { getHandoff } from '../../src/lib/handoff';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, typo, useTheme, weight } from '../../src/theme';
import { Icon } from '../../src/ui/core';
import { EmptyState } from '../../src/ui/empty';
import { useFontScaleKey } from '../../src/ui/font-scale';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function RelaySheet() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const fontKey = useFontScaleKey();
  const { k } = useLocalSearchParams<{ k?: string }>();
  const data = getHandoff<RelayPayload>(k);

  return (
    <>
      <Stack.Screen options={{ title: t('bots.thread.handoffTitle') }} />
      <SheetClose />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {data ? (
          <>
            {/* keyed on the text size: re-measures when Dynamic Type changes (src/ui/font-scale.ts) */}
            <View key={fontKey} style={styles.route} accessibilityRole="header">
              <View style={styles.party}>
                <BotAvatar bot={data.from} size={28} animate={false} />
                <Text numberOfLines={1} style={styles.name}>
                  {data.fromName}
                </Text>
              </View>
              <Icon name="chevR" size={11} weight="semibold" color={c.tertiaryLabel} />
              <View style={styles.party}>
                <BotAvatar bot={data.to} size={28} animate={false} />
                <Text numberOfLines={1} style={styles.name}>
                  {data.toName}
                </Text>
              </View>
            </View>
            {data.brief ? (
              <Markdown source={data.brief} />
            ) : (
              <Text style={styles.bare}>{t('bots.thread.handoffBare', { from: data.fromName, to: data.toName })}</Text>
            )}
          </>
        ) : (
          <EmptyState icon="msg" title={t('chat.expired')} message={t('chat.expiredHint')} />
        )}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  content: { paddingHorizontal: space.margin + 4, paddingTop: space.sm, paddingBottom: space.xxxl, gap: space.lg },
  route: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  party: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexShrink: 1 },
  name: { flexShrink: 1, ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  bare: { ...typo.body, color: c.secondaryLabel },
}));
