/**
 * A Bot's profile — the body of the `/bots/profile` sheet (the thread's title
 * opens it) and of the Settings → My Bots → Bot page (`presentation`).
 * Everything about one Bot in one place (2026-10: it absorbed the thread's
 * "Conversation Info"; "Invite a Bot" is gone — Bots bring each other in):
 *
 *  - bar: ✎ 新对话 (a fresh chat with this Bot, `profile=bot:<id>` / `sprouty`,
 *    never its ongoing thread) beside 编辑 (`/bots/bot-form?botId=`);
 *  - hero: the plant (it breathes while the screen is focused; an archived Bot
 *    sleeps), name, role; 发消息 (its DM — opened, or made with
 *    `POST /api/bots/conversations`; hidden when we came from that DM or Bots
 *    threads are off); an archived Bot only offers 查看对话;
 *  - a segmented control over six tabs (./profile-tabs.tsx): 概览 (instructions
 *    first) · 记忆 · 笔记 · 定时 · 对话 · 记录 (usage + what it did) — `tab` picks
 *    the first one shown (the thread's "summarized · View" opens 记忆).
 *
 * Someone else's public Agent (spec 20261011-agent-first-class §5c P4 — its
 * owner shared it with the member) shows only what its owner shared: the plant,
 * name, role, who shared it, what it is for, and 对话 (the member's own DM with
 * it — made with its greeting the first time). No edit, no new chat, no tabs
 * (its memory, notes, schedules and activity are its owner's business, not the
 * member's); once it is no longer shared, its DM stays readable.
 *
 * Navigating to a thread / new chat always `dismissTo`s home (closing this
 * sheet, or the whole Settings modal).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useIsFocused, useRouter } from 'expo-router';
import { archiveBot, createConversation } from '../../api/bots';
import { useT, type TranslationKey } from '../../lib/i18n';
import { isSproutyBot, type BotView, type SharedBotView } from '../../shared/bots';
import { makeStyles, space, typo, useTheme } from '../../theme';
import { NativeButton } from '../../ui/button';
import { ListCard, ListSectionFooter, ListSectionHeader } from '../../ui/list';
import { alertError, confirmAction } from '../../ui/dialogs';
import { EmptyState, LoadingState } from '../../ui/empty';
import { Segmented } from '../../ui/segmented';
import { toast } from '../../ui/toast';
import { toolbarIcon } from '../../ui/toolbar-icon';
import { useBotsEnabled } from '../availability';
import { openNewChat, openThread } from '../nav';
import { useBots } from '../store';
import { BotAvatar } from '../ui/bot-avatar';
import {
  ActivityTab,
  ChatsTab,
  MemoryTab,
  NotesTab,
  OverviewTab,
  PROFILE_TABS,
  ScheduleTab,
  type ProfileTab,
} from './profile-tabs';
import { useBotDirectory } from './use-bot-directory';

export function BotProfileView({
  botId,
  from,
  presentation,
  tab,
}: {
  botId: string;
  /** The conversation the profile was opened from (its DM hides 发消息). */
  from?: string;
  /** `sheet` — /bots/profile; `page` — /settings/bot (the name is the bar title). */
  presentation: 'sheet' | 'page';
  /** The tab shown first (default 概览). */
  tab?: ProfileTab;
}) {
  const t = useT();
  const bot = useBots((s) => s.byId[botId]);
  const shared = useBots((s) => s.shared[botId]);
  const ensureBotsKnown = useBots((s) => s.ensureBotsKnown);
  const directory = useBotDirectory();
  const botsLoaded = directory.loaded;
  // A Bot made on another device: one re-read of the list before saying it's gone.
  const [rechecked, setRechecked] = useState(false);

  useEffect(() => {
    if (!botsLoaded || bot || rechecked) return;
    let live = true;
    void ensureBotsKnown([botId]).then(() => {
      if (live) setRechecked(true);
    });
    return () => {
      live = false;
    };
  }, [botsLoaded, bot, rechecked, botId, ensureBotsKnown]);

  if (shared) return <SharedProfile agent={shared} from={from} presentation={presentation} />;
  if (!bot) {
    return (
      <>
        <Stack.Screen options={{ title: '' }} />
        <View style={{ flex: 1, justifyContent: 'center' }}>
          {botsLoaded && rechecked ? (
            <EmptyState icon="person" title={t('bots.manage.botMissing')} message={t('bots.manage.botMissingHint')} />
          ) : directory.failed ? (
            <EmptyState icon="alert" title={t('bots.manage.loadFailed')} onRetry={directory.retry} />
          ) : (
            <LoadingState />
          )}
        </View>
      </>
    );
  }
  return <Profile bot={bot} from={from} presentation={presentation} tab={tab} />;
}

/** Someone else's public Agent: only what its owner shared (see the file header). */
function SharedProfile({
  agent,
  from,
  presentation,
}: {
  agent: SharedBotView;
  from?: string;
  presentation: 'sheet' | 'page';
}) {
  const t = useT();
  const router = useRouter();
  const focused = useIsFocused();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const botsOn = useBotsEnabled();
  const [opening, setOpening] = useState(false);
  const dm = agent.dm_session_id;
  const description = agent.description.trim();

  const talk = useCallback(async () => {
    if (dm) {
      openThread(router, { c: dm, title: agent.name }, 'dismissTo');
      return;
    }
    setOpening(true);
    const result = await useBots.getState().startAgentChat(agent);
    setOpening(false);
    if (result.ok) openThread(router, { c: result.sessionId, title: agent.name }, 'dismissTo');
    else {
      alertError(result.reason === 'gone' ? t('bots.agents.gone', { name: agent.name }) : t('bots.manage.openFailed'));
    }
  }, [dm, router, agent, t]);

  return (
    <>
      <Stack.Screen options={{ title: presentation === 'page' ? agent.name : '' }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <BotAvatar
            bot={agent}
            size={80}
            state={agent.available ? undefined : 'sleep'}
            animate={focused && agent.available}
          />
          <Text accessibilityRole="header" style={styles.name}>
            {agent.name}
          </Text>
          {agent.role ? <Text style={styles.role}>{agent.role}</Text> : null}
          <Text style={styles.role}>{t('bots.profile.sharedBy', { name: agent.owner.nickname })}</Text>
        </View>

        {botsOn && (agent.available ? !dm || dm !== from : !!dm && dm !== from) ? (
          <View style={styles.actions}>
            {agent.available ? (
              <NativeButton
                label={dm ? t('bots.manage.message') : t('bots.profile.talk')}
                icon="msg"
                variant="prominent"
                loading={opening}
                onPress={() => void talk()}
              />
            ) : (
              <NativeButton label={t('bots.manage.viewChat')} icon="msg" onPress={() => void talk()} />
            )}
          </View>
        ) : null}

        <View style={styles.sharedBody}>
          {description ? (
            <>
              <ListSectionHeader title={t('bots.profile.sharedAbout')} />
              <ListCard style={styles.about}>
                <Text style={styles.aboutText}>{description}</Text>
              </ListCard>
            </>
          ) : null}
          <ListSectionFooter
            text={
              agent.available
                ? t('bots.profile.sharedFooter', { owner: agent.owner.nickname })
                : t('bots.profile.sharedUnavailable')
            }
          />
        </View>
      </ScrollView>
    </>
  );
}

function Profile({
  bot,
  from,
  presentation,
  tab: initialTab,
}: {
  bot: BotView;
  from?: string;
  presentation: 'sheet' | 'page';
  tab?: ProfileTab;
}) {
  const t = useT();
  const router = useRouter();
  const focused = useIsFocused();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const botsOn = useBotsEnabled();
  const archived = bot.status === 'archived';
  const main = isSproutyBot(bot);
  const [opening, setOpening] = useState(false);
  const [tab, setTab] = useState<ProfileTab>(initialTab ?? 'overview');

  const dm = bot.dm_session_id;
  const showMessage = botsOn && !archived && (!dm || dm !== from);

  const message = useCallback(async () => {
    if (dm) {
      openThread(router, { c: dm, title: bot.name }, 'dismissTo');
      return;
    }
    // No DM yet (made while Bots threads were off): this makes it, greeting included.
    setOpening(true);
    const result = await createConversation({ bot_ids: [bot.id] });
    setOpening(false);
    if (!result.ok) {
      alertError(t('bots.manage.openFailed'), result.message || undefined);
      return;
    }
    void useBots.getState().loadBots();
    openThread(router, { c: result.value.session_id, title: bot.name }, 'dismissTo');
  }, [dm, router, bot.id, bot.name, t]);

  const newChat = useCallback(() => {
    openNewChat(router, { profile: main ? 'sprouty' : `bot:${bot.id}` }, 'dismissTo');
  }, [router, main, bot.id]);

  const archive = useCallback(async () => {
    const ok = await confirmAction({
      title: t('bots.manage.archiveTitle', { name: bot.name }),
      message: t('bots.manage.archiveConfirm', { name: bot.name }),
      confirmLabel: t('bots.manage.archiveAction'),
      destructive: true,
    });
    if (!ok) return;
    const result = await archiveBot(bot.id);
    if (!result.ok) {
      alertError(t('bots.manage.archiveFailed', { name: bot.name }), result.message || undefined);
      return;
    }
    const store = useBots.getState();
    // Its DM turns read-only and its open cards were withdrawn: refresh what shows them.
    await store.loadBots();
    void store.loadConversations();
    void store.loadPending();
    toast(t('bots.manage.archivedToast', { name: bot.name }), 'archive');
    router.back();
  }, [bot.id, bot.name, router, t]);

  const tabs = useMemo(
    () =>
      PROFILE_TABS.map((value) => ({
        value,
        label: t(TAB_LABEL[value]),
      })),
    [t],
  );

  return (
    <>
      <Stack.Screen options={{ title: presentation === 'page' ? bot.name : '' }} />
      {/* New Chat beside Edit: a fresh conversation with it, never its ongoing thread */}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          hidden={archived}
          icon={toolbarIcon('compose')}
          accessibilityLabel={t('bots.manage.newChat')}
          onPress={newChat}
        />
        <Stack.Toolbar.Button
          hidden={archived}
          onPress={() => router.push({ pathname: '/bots/bot-form', params: { botId: bot.id } })}
        >
          {t('bots.manage.edit')}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <BotAvatar bot={bot} size={80} state={archived ? 'sleep' : undefined} animate={focused && !archived} />
          <Text accessibilityRole="header" style={styles.name}>
            {bot.name}
          </Text>
          {bot.role ? <Text style={styles.role}>{bot.role}</Text> : null}
        </View>

        {archived ? (
          dm && botsOn ? (
            <View style={styles.actions}>
              <NativeButton
                label={t('bots.manage.viewChat')}
                icon="msg"
                onPress={() => openThread(router, { c: dm, title: bot.name }, 'dismissTo')}
              />
            </View>
          ) : null
        ) : showMessage ? (
          <View style={styles.actions}>
            <NativeButton
              label={t('bots.manage.message')}
              icon="msg"
              variant="prominent"
              loading={opening}
              onPress={() => void message()}
            />
          </View>
        ) : null}

        <Segmented value={tab} options={tabs} onChange={setTab} style={styles.tabs} />

        {tab === 'overview' ? (
          <OverviewTab bot={bot} main={main} onArchive={() => void archive()} />
        ) : tab === 'memory' ? (
          <MemoryTab bot={bot} />
        ) : tab === 'notes' ? (
          <NotesTab bot={bot} />
        ) : tab === 'schedule' ? (
          <ScheduleTab bot={bot} main={main} />
        ) : tab === 'chats' ? (
          <ChatsTab bot={bot} main={main} />
        ) : (
          <ActivityTab bot={bot} />
        )}
      </ScrollView>
    </>
  );
}

const TAB_LABEL = {
  overview: 'bots.profile.tabOverview',
  memory: 'bots.profile.tabMemory',
  notes: 'bots.profile.tabNotes',
  schedule: 'bots.profile.tabSchedule',
  chats: 'bots.profile.tabChats',
  activity: 'bots.profile.tabActivity',
} as const satisfies Record<ProfileTab, TranslationKey>;

const useStyles = makeStyles((c) => ({
  content: { paddingBottom: space.xxxl },
  hero: { alignItems: 'center', paddingTop: space.lg, paddingHorizontal: space.margin, gap: space.xs },
  name: { ...typo.title2, color: c.label, textAlign: 'center', marginTop: space.sm },
  role: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center' },
  actions: { alignItems: 'center', paddingHorizontal: space.margin, paddingTop: space.lg },
  tabs: { marginHorizontal: space.margin, marginTop: space.xl, marginBottom: space.lg },
  sharedBody: { marginTop: space.xl },
  about: { paddingHorizontal: space.lg, paddingVertical: space.md },
  aboutText: { ...typo.body, color: c.label },
}));
