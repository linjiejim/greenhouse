/**
 * Settings → My Bots (`/settings/bots`, a large-title page in the settings
 * stack) — the one place Bots are made and managed (2026-10: the drawer's ＋
 * is gone). Shown to every internal account, Bots threads on or off — the
 * identity routes need no more (D21). Two halves (segmented):
 *
 *  - 我的 — 主助手 (Sprouty: New Chat uses it), 其他 Bot (plant, name, role;
 *    the last row 新建 Bot → /bots/new-bot, off at the 20-Bot limit, which
 *    the footer then states), 已归档 (asleep — still openable: their
 *    conversations stay readable). A row opens the full-page profile
 *    (`/settings/bot?id=`).
 *  - 示例 — the example Bots (`BOT_TEMPLATES`): face, name · role, what it
 *    does, "needs the computer" when the deployment has none → its sheet
 *    (`/bots/example?key=`, 用这个创建).
 *
 * The half shown is a store (src/bots/manage/my-bots-tab.ts): the New
 * Bot sheet's 从示例挑一个 switches it.
 */

import React, { useEffect, useMemo } from 'react';
import { ScrollView } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import { usePrefs } from '../../src/store/prefs';
import { BOT_TEMPLATES, MAX_ACTIVE_BOTS, isSproutyBot, type BotView } from '../../src/shared/bots';
import { useMyBotsTab, type MyBotsTab } from '../../src/bots/manage/my-bots-tab';
import { useBotDirectory } from '../../src/bots/manage/use-bot-directory';
import { useBots } from '../../src/bots/store';
import { BotAvatar } from '../../src/bots/ui/bot-avatar';
import { space } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSection } from '../../src/ui/list';
import { Segmented } from '../../src/ui/segmented';

const AVATAR = 30;
const EXAMPLE_AVATAR = 40;
/** Empty / failed states sit in the middle of the page. */
const CENTERED = { flexGrow: 1, justifyContent: 'center' } as const;

export default function SettingsBots() {
  const t = useT();
  const tab = useMyBotsTab((s) => s.tab);
  const setTab = useMyBotsTab((s) => s.setTab);
  // a new visit starts on 我的
  useEffect(() => () => setTab('mine'), [setTab]);
  // Every visit re-reads: a Bot made, renamed or archived elsewhere shows up here.
  const directory = useBotDirectory({ fresh: true });
  const tabs = useMemo(
    () => [
      { value: 'mine' as MyBotsTab, label: t('bots.manage.tabMine') },
      { value: 'examples' as MyBotsTab, label: t('bots.manage.tabExamples') },
    ],
    [t],
  );

  return (
    <>
      <Stack.Screen options={{ title: t('settings.myBots') }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          { paddingTop: space.sm, paddingBottom: space.xxxl },
          tab === 'mine' && !directory.loaded && CENTERED,
        ]}
      >
        <Segmented
          value={tab}
          options={tabs}
          onChange={setTab}
          style={{ marginHorizontal: space.margin, marginBottom: space.lg }}
        />
        {tab === 'examples' ? (
          <Examples />
        ) : !directory.loaded ? (
          directory.failed ? (
            <EmptyState icon="alert" title={t('bots.manage.loadFailed')} onRetry={directory.retry} />
          ) : (
            <LoadingState />
          )
        ) : (
          <Mine />
        )}
      </ScrollView>
    </>
  );
}

function Mine() {
  const t = useT();
  const router = useRouter();
  const bots = useBots((s) => s.bots);
  const archived = useBots((s) => s.archived);
  const main = bots.find(isSproutyBot) ?? null;
  const others = useMemo(() => bots.filter((bot) => !isSproutyBot(bot)), [bots]);
  const atLimit = others.length >= MAX_ACTIVE_BOTS;

  const row = (bot: BotView, opts: { asleep?: boolean } = {}) => (
    <ListRow
      key={bot.id}
      title={bot.name}
      subtitle={bot.role || undefined}
      subtitleLines={1}
      leading={<BotAvatar bot={bot} size={AVATAR} state={opts.asleep ? 'sleep' : undefined} animate={false} />}
      leadingWidth={AVATAR}
      accessory="chevron"
      onPress={() => router.push({ pathname: '/settings/bot', params: { id: bot.id } })}
    />
  );

  return (
    <>
      {main ? (
        <ListSection header={t('bots.manage.mainSection')} footer={t('bots.manage.mainFooter', { name: main.name })}>
          {row(main)}
        </ListSection>
      ) : null}

      <ListSection header={t('bots.manage.othersSection')} footer={atLimit ? t('bots.manage.limit') : undefined}>
        {[
          ...others.map((bot) => row(bot)),
          <ListRow
            key="new"
            title={t('bots.manage.formNew')}
            icon="plus"
            disabled={atLimit}
            onPress={() => router.push('/bots/new-bot')}
            last
          />,
        ]}
      </ListSection>

      {archived.length > 0 ? (
        <ListSection header={t('bots.manage.archivedSection')}>
          {archived.map((bot) => row(bot, { asleep: true }))}
        </ListSection>
      ) : null}
    </>
  );
}

function Examples() {
  const t = useT();
  const router = useRouter();
  const lang = usePrefs((s) => s.lang);
  const noComputer = useBots((s) => s.computer !== null && s.computer.state !== 'ready');
  return (
    <ListSection footer={t('bots.manage.examplesFooter')}>
      {BOT_TEMPLATES.map((template, index) => {
        const copy = template.copy[lang];
        return (
          <ListRow
            key={template.key}
            title={`${copy.name} · ${copy.role}`}
            subtitle={copy.pitch}
            subtitleLines={2}
            value={template.needsComputer && noComputer ? t('bots.manage.needsComputerShort') : undefined}
            leading={
              <BotAvatar
                bot={{ id: template.key, avatar: template.avatar, template_key: template.key }}
                size={EXAMPLE_AVATAR}
                animate={false}
              />
            }
            leadingWidth={EXAMPLE_AVATAR}
            accessory="chevron"
            onPress={() => router.push({ pathname: '/bots/example', params: { key: template.key } })}
            last={index === BOT_TEMPLATES.length - 1}
          />
        );
      })}
    </ListSection>
  );
}
