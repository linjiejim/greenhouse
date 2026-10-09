/**
 * `/bots/example?key=` — one example Bot (Settings → My Bots → 示例): its
 * face, name and role, what it is for (and whether it needs the computer the
 * deployment lacks), 用这个创建 → the Bot form pre-filled from it
 * (`/bots/bot-form?template=`, over this sheet), what to ask it and how it
 * works (its instructions). Examples are compile-time constants
 * (`BOT_TEMPLATES`, packages/types — vendored): nothing to load.
 */

import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { BotsRouteGate } from '../../src/bots/route-gate';
import { useBots } from '../../src/bots/store';
import { BotAvatar } from '../../src/bots/ui/bot-avatar';
import { Markdown } from '../../src/chat/markdown';
import { useT } from '../../src/lib/i18n';
import { BOT_TEMPLATES, MAX_ACTIVE_BOTS, isSproutyBot } from '../../src/shared/bots';
import { usePrefs } from '../../src/store/prefs';
import { makeStyles, space, squircle, typo, useTheme, weight } from '../../src/theme';
import { NativeButton } from '../../src/ui/button';
import { EmptyState } from '../../src/ui/empty';
import { ListCard, ListRow, ListSection, ListSectionHeader } from '../../src/ui/list';
import { SheetClose } from '../../src/ui/sheet-chrome';

/** Bot identity (internal accounts): closed → home, src/bots/route-gate.tsx. */
export default function ExampleRoute() {
  return (
    <BotsRouteGate kind="identity">
      <ExampleSheet />
    </BotsRouteGate>
  );
}

function ExampleSheet() {
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const lang = usePrefs((s) => s.lang);
  const { key } = useLocalSearchParams<{ key?: string }>();
  const template = BOT_TEMPLATES.find((row) => row.key === key);
  const noComputer = useBots((s) => s.computer !== null && s.computer.state !== 'ready');
  const atLimit = useBots((s) => s.bots.filter((bot) => !isSproutyBot(bot)).length >= MAX_ACTIVE_BOTS);

  if (!template) {
    return (
      <>
        <SheetClose />
        <View style={styles.missing}>
          <EmptyState icon="person" title={t('bots.manage.botMissing')} />
        </View>
      </>
    );
  }
  const copy = template.copy[lang];
  const computerMissing = template.needsComputer && noComputer;

  return (
    <>
      <Stack.Screen options={{ title: '' }} />
      <SheetClose />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <BotAvatar bot={{ id: template.key, avatar: template.avatar, template_key: template.key }} size={80} />
          <Text style={styles.name} accessibilityRole="header">
            {copy.name}
          </Text>
          <Text style={styles.role}>{copy.role}</Text>
          <Text style={styles.pitch}>{computerMissing && copy.pitchNoComputer ? copy.pitchNoComputer : copy.pitch}</Text>
          {computerMissing ? <Text style={styles.warn}>{t('bots.manage.computerWarn')}</Text> : null}
          <NativeButton
            label={t('bots.manage.useExample')}
            variant="prominent"
            size="large"
            fullWidth
            disabled={atLimit}
            onPress={() => router.push({ pathname: '/bots/bot-form', params: { template: template.key } })}
            style={styles.use}
          />
          {atLimit ? <Text style={styles.limit}>{t('bots.manage.limit')}</Text> : null}
        </View>

        <ListSection header={t('bots.manage.tryAsking')}>
          {copy.starters.map((starter, index) => (
            <ListRow key={starter} icon="msg" title={starter} titleLines={3} last={index === copy.starters.length - 1} />
          ))}
        </ListSection>

        <View style={styles.section}>
          <ListSectionHeader title={t('bots.manage.instructions')} />
          <ListCard style={styles.card}>
            <Markdown source={copy.instructions} />
          </ListCard>
        </View>
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  content: { paddingBottom: space.xxxl },
  missing: { flex: 1, justifyContent: 'center' },
  hero: { alignItems: 'center', paddingHorizontal: space.margin, paddingTop: space.md, paddingBottom: space.xl },
  name: { ...typo.title2, fontWeight: weight.bold, color: c.label, textAlign: 'center', marginTop: space.md },
  role: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center', marginTop: 2 },
  pitch: { ...typo.body, color: c.label, textAlign: 'center', marginTop: space.md },
  warn: { ...typo.footnote, color: c.orange, textAlign: 'center', marginTop: space.sm },
  use: { alignSelf: 'stretch', marginTop: space.lg },
  limit: { ...typo.footnote, color: c.secondaryLabel, textAlign: 'center', marginTop: space.sm },
  section: { marginBottom: space.xxl },
  card: { padding: space.margin, ...squircle },
}));
