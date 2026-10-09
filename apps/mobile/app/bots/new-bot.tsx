/**
 * `/bots/new-bot` — how a Bot is made (Settings → My Bots → 新建 Bot). The
 * default is to ask Sprouty (2026-10): pick an idea, or describe your own →
 * Sprouty's thread opens with "帮我建一个 Bot：…" in the composer — prefilled,
 * never sent: the member finishes it and sends, Sprouty answers with a "new
 * Bot" card to approve (the Bot form, pre-filled). The other ways, below:
 * 从示例挑一个 (back to My Bots, its 示例 half) and 手动填写 (the blank form).
 *
 * Asking Sprouty needs its thread (Bots threads on); without one only the
 * other two show.
 */

import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useBotsEnabled } from '../../src/bots/availability';
import { useMyBotsTab } from '../../src/bots/manage/my-bots-tab';
import { openThread } from '../../src/bots/nav';
import { BotsRouteGate } from '../../src/bots/route-gate';
import { sproutyBot, sproutyDm, useBots } from '../../src/bots/store';
import { BotAvatar } from '../../src/bots/ui/bot-avatar';
import { fillComposer } from '../../src/chat/composer-bridge';
import { useT, type TranslationKey } from '../../src/lib/i18n';
import { BOT_TEMPLATES } from '../../src/shared/bots';
import { AFTER_DISMISS_MS } from '../../src/store/auth';
import { makeStyles, space, typo, useTheme, weight } from '../../src/theme';
import { NativeButton } from '../../src/ui/button';
import { ListRow, ListSection } from '../../src/ui/list';
import { SheetClose } from '../../src/ui/sheet-chrome';

const IDEAS: readonly TranslationKey[] = [
  'bots.manage.ideas.news',
  'bots.manage.ideas.email',
  'bots.manage.ideas.overdue',
  'bots.manage.ideas.minutes',
  'bots.manage.ideas.support',
];

/** Bot identity (internal accounts): closed → home, src/bots/route-gate.tsx. */
export default function NewBotRoute() {
  return (
    <BotsRouteGate kind="identity">
      <NewBotSheet />
    </BotsRouteGate>
  );
}

function NewBotSheet() {
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const threads = useBotsEnabled();
  const sprouty = useBots(sproutyBot);
  const dm = useBots((s) => (threads ? sproutyDm(s) : null));

  const ask = (idea: string) => {
    if (!sprouty || !dm) return;
    openThread(router, { c: dm, title: sprouty.name, compose: true }, 'dismissTo');
    // after the sheets are gone: the thread under them must not take the keyboard first
    setTimeout(() => fillComposer(t('bots.manage.ideaMessage', { idea }), dm), AFTER_DISMISS_MS);
  };

  return (
    <>
      <Stack.Screen options={{ title: t('bots.manage.formNew') }} />
      <SheetClose />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {sprouty && dm ? (
          <View style={styles.ask}>
            <BotAvatar bot={sprouty} size={56} />
            <Text style={styles.askTitle} accessibilityRole="header">
              {t('bots.manage.askSprouty', { name: sprouty.name })}
            </Text>
            <Text style={styles.askHint}>{t('bots.manage.askSproutyHint', { name: sprouty.name })}</Text>
            <View style={styles.ideas}>
              {IDEAS.map((key) => (
                <NativeButton key={key} label={t(key)} size="small" onPress={() => ask(t(key))} />
              ))}
            </View>
            <NativeButton
              label={t('bots.manage.describeOwn')}
              icon="compose"
              variant="prominent"
              size="large"
              fullWidth
              onPress={() => ask('')}
              style={styles.describe}
            />
          </View>
        ) : null}
        <ListSection header={sprouty && dm ? t('bots.manage.otherWays') : undefined}>
          <ListRow
            icon="sparkle"
            title={t('bots.manage.fromExample')}
            subtitle={t('bots.manage.fromExampleHint', { n: BOT_TEMPLATES.length })}
            accessory="chevron"
            onPress={() => {
              useMyBotsTab.getState().setTab('examples');
              router.back();
            }}
          />
          <ListRow
            icon="pen"
            title={t('bots.manage.manual')}
            subtitle={t('bots.manage.manualHint')}
            accessory="chevron"
            onPress={() => router.push({ pathname: '/bots/bot-form', params: { template: 'custom' } })}
            last
          />
        </ListSection>
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  content: { paddingBottom: space.xxxl },
  ask: { alignItems: 'center', paddingHorizontal: space.margin, paddingTop: space.lg, paddingBottom: space.xl },
  askTitle: { ...typo.title3, fontWeight: weight.semibold, color: c.label, textAlign: 'center', marginTop: space.md },
  askHint: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center', marginTop: space.xs },
  ideas: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: space.sm,
    marginTop: space.lg,
  },
  describe: { alignSelf: 'stretch', marginTop: space.lg },
}));
