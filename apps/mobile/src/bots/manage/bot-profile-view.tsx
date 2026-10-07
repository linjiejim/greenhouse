/**
 * A Bot's profile — the body of the `/bots/profile` sheet and of the
 * Settings → My Bots → Bot page (`presentation`), spec
 * docs/specs/20261008-mobile-bots.md §2.5.7. Content-first, so a plain RN
 * `ScrollView` with the list kit (Contacts-card layout), not a Form:
 *
 *  - hero: the plant (it breathes while the screen is focused; an archived Bot
 *    sleeps), name, role, "v{n} · Created {date}";
 *  - actions: 发消息 (its DM — opened, or made with `POST /api/bots/conversations`;
 *    hidden when we came from that DM or Bots threads are off) and 新对话 (a
 *    fresh chat with this Bot, `profile=bot:<id>` / `sprouty`, never its
 *    ongoing thread); an archived Bot only offers 查看对话 (its read-only DM);
 *  - purpose, instructions (six lines + 显示全部);
 *  - what it alone remembers (`GET /api/bots/:id/memories`, active / dormant):
 *    touch and hold → 忘掉这条 (also a VoiceOver action), removed at once (a
 *    404 means already gone);
 *  - archive: never Sprouty (a footnote says why); otherwise confirmed, then
 *    `DELETE /api/bots/:id` — its conversation stays, read-only.
 *
 * The navigation bar's 编辑 opens `/bots/bot-form?botId=` over it. Navigating
 * to a thread / new chat always `dismissTo`s home (closing this sheet, or the
 * whole Settings modal).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useIsFocused, useRouter } from 'expo-router';
import { archiveBot, createConversation, deleteBotMemory, listBotMemories } from '../../api/bots';
import { useLocale, useT } from '../../lib/i18n';
import { isSproutyBot, type BotView } from '../../shared/bots';
import type { BotMemoryView } from '../../shared/bots-wire';
import { makeStyles, space, squircle, typo, useTheme, weight } from '../../theme';
import { NativeButton } from '../../ui/button';
import { Icon, Spinner } from '../../ui/core';
import { alertError, confirmAction } from '../../ui/dialogs';
import { EmptyState, LoadingState } from '../../ui/empty';
import { ListCard, ListRow, ListSection, ListSectionFooter, ListSectionHeader } from '../../ui/list';
import { NativeMenu, type MenuItem } from '../../ui/menu';
import { toast } from '../../ui/toast';
import { useBotsEnabled } from '../availability';
import { openNewChat, openThread } from '../nav';
import { useBots } from '../store';
import { BotAvatar } from '../ui/bot-avatar';
import { useBotDirectory } from './use-bot-directory';

/** Instructions longer than this read as "more than six lines" and fold. */
const FOLD_LINES = 6;
const FOLD_CHARS = 280;

export function BotProfileView({
  botId,
  from,
  presentation,
}: {
  botId: string;
  /** The conversation the profile was opened from (its DM hides 发消息). */
  from?: string;
  /** `sheet` — /bots/profile; `page` — /settings/bot (the name is the bar title). */
  presentation: 'sheet' | 'page';
}) {
  const t = useT();
  const bot = useBots((s) => s.byId[botId]);
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
  return <Profile bot={bot} from={from} presentation={presentation} />;
}

function Profile({ bot, from, presentation }: { bot: BotView; from?: string; presentation: 'sheet' | 'page' }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const focused = useIsFocused();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const botsOn = useBotsEnabled();
  const archived = bot.status === 'archived';
  const main = isSproutyBot(bot);
  const [opening, setOpening] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const created = useMemo(() => {
    const at = Date.parse(bot.created_at);
    if (!Number.isFinite(at)) return '';
    try {
      return new Date(at).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return bot.created_at.slice(0, 10);
    }
  }, [bot.created_at, locale]);

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

  const instructions = bot.instructions.trim();
  const folds = instructions.split('\n').length > FOLD_LINES || instructions.length > FOLD_CHARS;

  return (
    <>
      <Stack.Screen options={{ title: presentation === 'page' ? bot.name : '' }} />
      <Stack.Toolbar placement="right">
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
          <Text style={styles.version}>{t('bots.manage.versionLine', { n: bot.current_version, date: created })}</Text>
        </View>

        <View style={styles.actions}>
          {archived ? (
            dm && botsOn ? (
              <NativeButton
                label={t('bots.manage.viewChat')}
                icon="msg"
                onPress={() => openThread(router, { c: dm, title: bot.name }, 'dismissTo')}
              />
            ) : null
          ) : (
            <>
              {showMessage ? (
                <NativeButton
                  label={t('bots.manage.message')}
                  icon="msg"
                  variant="prominent"
                  loading={opening}
                  onPress={() => void message()}
                />
              ) : null}
              <NativeButton label={t('bots.manage.newChat')} icon="compose" onPress={newChat} />
            </>
          )}
        </View>

        {bot.description.trim() ? <TextSection title={t('bots.manage.purpose')} text={bot.description.trim()} /> : null}
        {instructions ? (
          <TextSection
            title={t('bots.manage.instructions')}
            text={instructions}
            lines={folds && !expanded ? FOLD_LINES : undefined}
            toggle={
              folds
                ? {
                    label: expanded ? t('bots.manage.showLess') : t('bots.manage.showAll'),
                    onPress: () => setExpanded((v) => !v),
                  }
                : undefined
            }
          />
        ) : null}

        <Memories bot={bot} />

        {main ? (
          <ListSectionFooter text={t('bots.manage.mainBot', { name: bot.name })} style={styles.closing} />
        ) : !archived ? (
          <View style={styles.archive}>
            <NativeButton label={t('bots.manage.archive')} icon="archive" destructive onPress={() => void archive()} />
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

/** A titled text card (purpose, instructions) — optionally folded with a 显示全部 / 收起 link. */
function TextSection({
  title,
  text,
  lines,
  toggle,
}: {
  title: string;
  text: string;
  lines?: number;
  toggle?: { label: string; onPress: () => void };
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.section}>
      <ListSectionHeader title={title} />
      <ListCard style={styles.card}>
        <Text style={styles.body} numberOfLines={lines} selectable={lines === undefined}>
          {text}
        </Text>
        {toggle ? (
          <Pressable onPress={toggle.onPress} accessibilityRole="button" hitSlop={space.sm} style={styles.toggle}>
            <Text style={styles.toggleText}>{toggle.label}</Text>
          </Pressable>
        ) : null}
      </ListCard>
    </View>
  );
}

/** What this Bot alone remembers about the member — every item can be forgotten. */
function Memories({ bot }: { bot: BotView }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [memories, setMemories] = useState<BotMemoryView[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const result = await listBotMemories(bot.id);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    setMemories(result.value.filter((row) => row.status === 'active' || row.status === 'dormant'));
  }, [bot.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const forget = useCallback(
    async (memory: BotMemoryView) => {
      setMemories((rows) => rows?.filter((row) => row.id !== memory.id) ?? null);
      const result = await deleteBotMemory(bot.id, memory.id);
      // 404: already gone — what the member asked for.
      if (result.ok || result.status === 404) {
        toast(t('bots.manage.forgotten'), 'check');
        return;
      }
      alertError(t('bots.manage.forgetFailed'), result.message || undefined);
      void load();
    },
    [bot.id, load, t],
  );

  const items = useMemo<MenuItem[]>(
    () => [{ id: 'forget', title: t('bots.manage.forget'), icon: 'trash', destructive: true }],
    [t],
  );

  const header = t('bots.manage.memories');
  if (memories === null) {
    return (
      <View style={styles.section}>
        <ListSectionHeader title={header} />
        {failed ? (
          <ListCard>
            <ListRow title={t('bots.manage.memoriesFailed')} onPress={() => void load()} last />
          </ListCard>
        ) : (
          <ListCard style={styles.pending}>
            <Spinner />
          </ListCard>
        )}
      </View>
    );
  }
  return (
    <ListSection header={header} footer={t('bots.manage.memoriesFooter', { name: bot.name })}>
      {memories.length === 0 ? (
        <ListRow title={t('bots.manage.noMemories')} />
      ) : (
        memories.map((memory) => (
          <MemoryRow key={memory.id} memory={memory} items={items} onForget={() => void forget(memory)} />
        ))
      )}
    </ListSection>
  );
}

function MemoryRow({
  memory,
  items,
  onForget,
  last,
}: {
  memory: BotMemoryView;
  items: MenuItem[];
  onForget: () => void;
  /** Injected by ListSection. */
  last?: boolean;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  return (
    <NativeMenu trigger="longPress" items={items} onSelect={(id) => id === 'forget' && onForget()}>
      <ListRow
        title={memory.title}
        subtitle={memory.content}
        subtitleLines={4}
        titleLines={2}
        accessory={memory.pinned ? <Icon name="pin" size={13} color={c.tertiaryLabel} /> : 'none'}
        // the pin glyph is decorative: say it; and Forget is in the actions rotor
        accessibilityLabel={[memory.title, memory.content, memory.pinned ? t('bots.nav.pinnedA11y') : null]
          .filter(Boolean)
          .join(', ')}
        accessibilityActions={[{ name: 'forget', label: t('bots.manage.forget') }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'forget') onForget();
        }}
        last={last}
      />
    </NativeMenu>
  );
}

const useStyles = makeStyles((c) => ({
  content: { paddingBottom: space.xxxl },
  hero: { alignItems: 'center', paddingTop: space.lg, paddingHorizontal: space.margin, gap: space.xs },
  name: { ...typo.title2, color: c.label, textAlign: 'center', marginTop: space.sm },
  role: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center' },
  version: { ...typo.footnote, color: c.tertiaryLabel, textAlign: 'center' },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.margin,
    paddingTop: space.lg,
    paddingBottom: space.xxl,
  },
  section: { marginBottom: space.xxl },
  card: { padding: space.margin, gap: space.sm, ...squircle },
  body: { ...typo.body, color: c.label },
  toggle: { alignSelf: 'flex-start' },
  toggleText: { ...typo.subheadline, fontWeight: weight.semibold, color: c.accentText },
  pending: { alignItems: 'center', paddingVertical: space.lg },
  archive: { alignItems: 'center', paddingTop: space.sm },
  closing: { textAlign: 'center' },
}));
