/**
 * Settings → My Bots (`/settings/bots`, a large-title page in the settings
 * stack): the member's Bot identities (spec docs/specs/20261008-mobile-bots.md
 * §2.5.7). Shown to every internal account, Bots threads on or off — the
 * identity routes need no more (D21).
 *
 *  - 主助手: Sprouty, with the footnote tying the two Sproutys together (New
 *    Chat uses it; the ongoing conversation in Bots is the same one);
 *  - 其他 Bot: plant, name, role, version; the last row 新建 Bot is a menu of
 *    the gallery templates + 自定义… (off at the 20-Bot limit, which the
 *    footer then states) → the Bot form sheet;
 *  - 已归档: asleep — still openable (their conversations stay readable).
 *
 * A row opens the full-page profile (`/settings/bot?id=`).
 */

import React, { useMemo } from 'react';
import { ScrollView } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import { usePrefs } from '../../src/store/prefs';
import { BOT_TEMPLATES, MAX_ACTIVE_BOTS, isSproutyBot, type BotView } from '../../src/shared/bots';
import { useBotDirectory } from '../../src/bots/manage/use-bot-directory';
import { useBots } from '../../src/bots/store';
import { BotAvatar } from '../../src/bots/ui/bot-avatar';
import { space } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSection } from '../../src/ui/list';
import { NativeMenu, menuSections, type MenuItem } from '../../src/ui/menu';

const AVATAR = 30;
/** Empty / failed states sit in the middle of the page. */
const CENTERED = { flexGrow: 1, justifyContent: 'center' } as const;

export default function SettingsBots() {
  const t = useT();
  const router = useRouter();
  const lang = usePrefs((s) => s.lang);
  const bots = useBots((s) => s.bots);
  const archived = useBots((s) => s.archived);
  const computer = useBots((s) => s.computer);
  // Every visit re-reads: a Bot made, renamed or archived elsewhere shows up here.
  const directory = useBotDirectory({ fresh: true });
  const botsLoaded = directory.loaded;

  const main = bots.find(isSproutyBot) ?? null;
  const others = useMemo(() => bots.filter((bot) => !isSproutyBot(bot)), [bots]);
  const atLimit = others.length >= MAX_ACTIVE_BOTS;
  const noComputer = computer !== null && computer.state !== 'ready';

  const newBotItems = useMemo<MenuItem[]>(
    () =>
      menuSections([
        BOT_TEMPLATES.map((template) => {
          const copy = template.copy[lang];
          const hint = template.needsComputer && noComputer ? ` · ${t('bots.manage.needsComputerShort')}` : '';
          return { id: template.key, title: `${copy.role} · ${copy.name}${hint}` };
        }),
        [{ id: 'custom', title: t('bots.manage.custom') }],
      ]),
    [lang, noComputer, t],
  );

  const open = (bot: BotView) => router.push({ pathname: '/settings/bot', params: { id: bot.id } });

  const row = (bot: BotView, opts: { asleep?: boolean } = {}) => (
    <ListRow
      key={bot.id}
      title={bot.name}
      subtitle={[bot.role, `v${bot.current_version}`].filter(Boolean).join(' · ')}
      subtitleLines={1}
      leading={<BotAvatar bot={bot} size={AVATAR} state={opts.asleep ? 'sleep' : undefined} animate={false} />}
      leadingWidth={AVATAR}
      accessory="chevron"
      onPress={() => open(bot)}
    />
  );

  return (
    <>
      <Stack.Screen options={{ title: t('settings.myBots') }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[{ paddingTop: space.sm, paddingBottom: space.xxxl }, !botsLoaded && CENTERED]}
      >
        {!botsLoaded ? (
          directory.failed ? (
            <EmptyState icon="alert" title={t('bots.manage.loadFailed')} onRetry={directory.retry} />
          ) : (
            <LoadingState />
          )
        ) : (
          <>
            {main ? (
              <ListSection
                header={t('bots.manage.mainSection')}
                footer={t('bots.manage.mainFooter', { name: main.name })}
              >
                {row(main)}
              </ListSection>
            ) : null}

            <ListSection header={t('bots.manage.othersSection')} footer={atLimit ? t('bots.manage.limit') : undefined}>
              {[
                ...others.map((bot) => row(bot)),
                atLimit ? (
                  <ListRow key="new" title={t('bots.manage.formNew')} icon="plus" disabled />
                ) : (
                  <NativeMenu
                    key="new"
                    trigger="tap"
                    fill
                    items={newBotItems}
                    onSelect={(id) => router.push({ pathname: '/bots/bot-form', params: { template: id } })}
                  >
                    {/* the menu is the tap target; always the section's last row */}
                    <ListRow title={t('bots.manage.formNew')} icon="plus" last />
                  </NativeMenu>
                ),
              ]}
            </ListSection>

            {archived.length > 0 ? (
              <ListSection header={t('bots.manage.archivedSection')}>
                {archived.map((bot) => row(bot, { asleep: true }))}
              </ListSection>
            ) : null}
          </>
        )}
      </ScrollView>
    </>
  );
}
