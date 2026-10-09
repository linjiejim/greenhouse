/**
 * The drawer's first section — Bots (spec docs/specs/20261008-mobile-bots.md
 * §2.5.1, D1). The drawer is this app's conversation navigation, so talking
 * and switching to another Bot are the same right swipe:
 *
 *  - a header "Bots" with ＋ — a system menu: New Bot ▸ (the four templates,
 *    the ones that need a computer this deployment lacks under their own
 *    heading — a hint, not a block — then Custom…) and New Group (disabled,
 *    with the reason as the menu title, under two active Bots / at the cap);
 *  - Sprouty's DM, always first and pinned; then the conversations someone can
 *    still reply in, in the server's order (newest activity first — never
 *    re-sorted by attention, so rows keep their place); five of them, then
 *    "Show All (N)" expands in place for the rest of this run;
 *  - "Archived (N)" → the read-only conversations (`/bots/archived`);
 *  - a failed first load is one quiet "Couldn't load Bots · Retry" line — no
 *    alert. A 403 / an older server closes the whole section (`useBotsEnabled`),
 *    and with Bots off the drawer is exactly what it was before Bots.
 *
 * Opening the drawer refreshes the list (at most once per 400 ms); the first
 * look also makes sure Sprouty has its DM (`ensureSprouty` — at most one
 * bootstrap per app session). Rows open with `replace` (the home cross-fade,
 * no back stack); sheets open after the drawer has slid shut.
 */

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { useGlobalSearchParams, useRouter } from 'expo-router';
import { useDrawerStatus } from 'expo-router/drawer';
import { markConversationRead } from '../../api/bots';
import {
  BOT_TEMPLATES,
  isSproutyBot,
  MAX_ACTIVE_BOTS,
  type BotConversationSummary,
  type BotView,
} from '../../shared/bots';
import { useT } from '../../lib/i18n';
import { usePrefs } from '../../store/prefs';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../theme';
import { Icon } from '../../ui/core';
import { useFontScaleKey } from '../../ui/font-scale';
import { alertError } from '../../ui/dialogs';
import { DRAWER_W } from '../../ui/drawer';
import { NativeMenu, type MenuItem } from '../../ui/menu';
import { useBotsEnabled } from '../availability';
import { openThread } from '../nav';
import { drawerRows, sproutyBot, sproutyDm, useBots } from '../store';
import { ConversationRow, ROW_TEXT_INSET, useRowCopy, type RowMenuAction } from './conversation-row';
import { rowTitle } from './row-text';

/** Rows sit inset in the panel like the history's; their menus get this width up front. */
const ROW_INSET = space.sm;
const ROW_W = DRAWER_W - ROW_INSET * 2;
/** Let the drawer slide shut before a sheet / page comes up over it. */
const AFTER_CLOSE_MS = 160;
/** Opening the drawer twice in a row reads the list once. */
const RELOAD_GAP_MS = 400;

/** "Show All" stays expanded for the rest of this run (spec §2.5.1). */
let expandedThisRun = false;
let lastLoadAt = 0;

const ROW_LAYOUT = LinearTransition.duration(220);
const ROW_ENTER = FadeIn.duration(180);

export function BotsSection({ query, onClose }: { query: string; onClose(): void }) {
  return useBotsEnabled() ? <Section query={query} onClose={onClose} /> : null;
}

function Section({ query, onClose }: { query: string; onClose(): void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  // keyed on the text size: the head and footer lines re-measure when Dynamic Type changes (src/ui/font-scale.ts)
  const fontKey = useFontScaleKey();
  const t = useT();
  const router = useRouter();
  const copy = useRowCopy();
  const { c: currentSid } = useGlobalSearchParams<{ c?: string }>();

  const bots = useBots((s) => s.bots);
  const byId = useBots((s) => s.byId);
  const botsLoaded = useBots((s) => s.botsLoaded);
  const conversations = useBots((s) => s.conversations);
  const conversationsLoaded = useBots((s) => s.conversationsLoaded);
  const failed = useBots((s) => s.error === 'failed');
  const computer = useBots((s) => s.computer);
  const lang = usePrefs((s) => s.lang);
  const [expanded, setExpanded] = useState(expandedThisRun);

  // Every open: refresh in place; the first look also makes sure Sprouty has its DM.
  const status = useDrawerStatus();
  useEffect(() => {
    if (status !== 'open' || Date.now() - lastLoadAt < RELOAD_GAP_MS) return;
    lastLoadAt = Date.now();
    void (async () => {
      const store = useBots.getState();
      if (!store.botsLoaded) await store.loadBots();
      await useBots.getState().loadConversations();
      const after = useBots.getState();
      if (after.botsLoaded && after.conversationsLoaded) void after.ensureSprouty();
    })();
  }, [status]);

  const rows = useMemo(
    () => drawerRows({ bots, byId, botsLoaded, conversations }, { query, expanded }),
    [bots, byId, botsLoaded, conversations, query, expanded],
  );
  const dir = useMemo(() => ({ byId, botsLoaded }), [byId, botsLoaded]);

  // Sprouty before its DM row is listed (still loading, or not bootstrapped yet): a stand-in row.
  const sprouty = sproutyBot({ bots });
  const sproutySid = sproutyDm({ bots, conversations });
  const pinned = useMemo<BotConversationSummary | null>(() => {
    if (rows.pinned) return rows.pinned;
    if (!sprouty || (query.trim() && !sprouty.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))) {
      return null;
    }
    return standIn(sprouty, sproutySid);
  }, [rows.pinned, sprouty, sproutySid, query]);

  const close = onClose;
  const later = useCallback(
    (go: () => void) => {
      close();
      setTimeout(go, AFTER_CLOSE_MS);
    },
    [close],
  );

  const open = useCallback(
    async (row: BotConversationSummary) => {
      close();
      if (row.session_id && row.session_id === currentSid) return;
      const title = rowTitle(row, dir, copy);
      // The stand-in Sprouty row: its DM may still need the bootstrap.
      const sid = row.session_id || (await useBots.getState().ensureSprouty());
      if (sid) openThread(router, { c: sid, title });
      else alertError(t('bots.nav.unavailable'));
    },
    [close, currentSid, dir, copy, router, t],
  );

  const onRowMenu = useCallback(
    (row: BotConversationSummary, action: RowMenuAction) => {
      const sid = row.session_id;
      if (action === 'open') void open(row);
      else if (action === 'profile' && row.owner_bot_id) {
        const botId = row.owner_bot_id;
        later(() => router.push({ pathname: '/bots/profile', params: { botId, from: sid } }));
      } else if (action === 'info') {
        later(() => router.push({ pathname: '/bots/info', params: { c: sid } }));
      } else if (action === 'markRead') {
        useBots.getState().noteRead(sid);
        void markConversationRead(sid).then((ok) => {
          if (ok) return;
          alertError(t('bots.nav.markReadFailed'));
          void useBots.getState().loadConversations(); // put the dot back
        });
      }
    },
    [open, later, router, t],
  );

  /* ---------- ＋ : New Bot ▸ / New Group ---------- */
  const others = bots.filter((bot) => !isSproutyBot(bot)).length;
  const atLimit = others >= MAX_ACTIVE_BOTS;
  const tooFew = bots.length < 2;
  const addTitle =
    [atLimit && t('bots.nav.limitReached'), tooFew && t('bots.nav.groupNeedsTwo')].filter(Boolean).join(' · ') ||
    undefined;
  const addItems = useMemo<MenuItem[]>(() => {
    const noComputer = !!computer && computer.state !== 'ready';
    const item = (tpl: (typeof BOT_TEMPLATES)[number]): MenuItem => ({
      id: `template:${tpl.key}`,
      title: t('bots.nav.templateItem', { role: tpl.copy[lang].role, name: tpl.copy[lang].name }),
    });
    const ready = BOT_TEMPLATES.filter((tpl) => !(tpl.needsComputer && noComputer));
    const blocked = BOT_TEMPLATES.filter((tpl) => tpl.needsComputer && noComputer);
    const newBot: MenuItem[] = [
      ...(ready.length ? [{ id: '__ready', title: '', inline: true, children: ready.map(item) }] : []),
      // a hint only: these still work for everything but browsing
      ...(blocked.length
        ? [{ id: '__computer', title: t('bots.nav.needsComputer'), inline: true, children: blocked.map(item) }]
        : []),
      {
        id: '__custom',
        title: '',
        inline: true,
        children: [{ id: 'template:custom', title: t('bots.nav.custom'), icon: 'pen' }],
      },
    ];
    return [
      { id: 'newBot', title: t('bots.nav.newBot'), icon: 'sparkle', disabled: atLimit, children: newBot },
      { id: 'newGroup', title: t('bots.nav.newGroup'), icon: 'users', disabled: tooFew },
    ];
  }, [computer, lang, atLimit, tooFew, t]);

  const onAdd = useCallback(
    (id: string) => {
      if (id === 'newGroup') later(() => router.push('/bots/new-group'));
      else if (id.startsWith('template:')) {
        const template = id.slice('template:'.length);
        later(() => router.push({ pathname: '/bots/bot-form', params: { template } }));
      }
    },
    [later, router],
  );

  const expand = useCallback(() => {
    expandedThisRun = true;
    setExpanded(true);
  }, []);
  const openArchived = useCallback(() => later(() => router.push('/bots/archived')), [later, router]);
  const retry = useCallback(() => {
    lastLoadAt = Date.now();
    void (async () => {
      await useBots.getState().loadBots();
      await useBots.getState().loadConversations();
    })();
  }, []);

  const searching = !!query.trim();
  const total = rows.recent.length + rows.moreCount;
  // A search that matches no Bot hides the section; the history below carries the results.
  if (searching && !pinned && rows.recent.length === 0 && rows.archived.length === 0) return null;
  // Hairlines run between rows — not after the last, and not against the highlighted current row.
  const pinnedCurrent = !!pinned?.session_id && pinned.session_id === currentSid;
  const separated = (current: boolean, next: BotConversationSummary | undefined) =>
    !!next && !current && next.session_id !== currentSid;

  return (
    <View style={styles.section}>
      <View key={`head:${fontKey}`} style={styles.head}>
        <Text accessibilityRole="header" style={styles.headTitle}>
          {t('bots.nav.section')}
        </Text>
        <NativeMenu title={addTitle} items={addItems} onSelect={onAdd}>
          <View style={styles.addBtn} accessible accessibilityRole="button" accessibilityLabel={t('bots.nav.addA11y')}>
            <Icon name="plus" size={17} color={c.secondaryLabel} weight="medium" />
          </View>
        </NativeMenu>
      </View>

      {pinned ? (
        <DrawerRow
          row={pinned}
          current={!!pinned.session_id && pinned.session_id === currentSid}
          separator={separated(pinnedCurrent, rows.recent[0])}
          onOpen={open}
          // the stand-in has no conversation to act on yet
          onMenu={pinned.session_id && rows.pinned ? onRowMenu : undefined}
        />
      ) : null}
      {rows.recent.map((row, index) => (
        <DrawerRow
          key={row.session_id}
          row={row}
          current={row.session_id === currentSid}
          separator={separated(row.session_id === currentSid, rows.recent[index + 1])}
          onOpen={open}
          onMenu={onRowMenu}
        />
      ))}

      {rows.moreCount > 0 ? (
        <Animated.View layout={ROW_LAYOUT}>
          <Pressable
            key={fontKey}
            onPress={expand}
            accessibilityRole="button"
            style={({ pressed }) => [styles.textRow, pressed && { backgroundColor: c.fill }]}
          >
            <Text style={styles.moreText}>{t('bots.nav.showAll', { n: total })}</Text>
          </Pressable>
        </Animated.View>
      ) : null}
      {rows.archived.length > 0 ? (
        <Animated.View layout={ROW_LAYOUT}>
          <Pressable
            key={fontKey}
            onPress={openArchived}
            accessibilityRole="button"
            style={({ pressed }) => [styles.textRow, pressed && { backgroundColor: c.fill }]}
          >
            <Text style={styles.archivedText}>{t('bots.nav.archived', { n: rows.archived.length })}</Text>
            <Icon name="chevR" size={13} color={c.tertiaryLabel} weight="semibold" />
          </Pressable>
        </Animated.View>
      ) : null}
      {failed && !conversationsLoaded ? (
        <Pressable
          onPress={retry}
          accessibilityRole="button"
          style={({ pressed }) => [styles.textRow, pressed && { backgroundColor: c.fill }]}
        >
          <Text style={styles.archivedText}>{t('bots.nav.loadFailed')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** One row with stable handlers bound to it, so `ConversationRow`'s memo holds across list updates. */
const DrawerRow = memo(function DrawerRow({
  row,
  current,
  separator,
  onOpen,
  onMenu,
}: {
  row: BotConversationSummary;
  current: boolean;
  /** A hairline under the row, from its text column on (not after the last row). */
  separator: boolean;
  onOpen(row: BotConversationSummary): void;
  onMenu?: (row: BotConversationSummary, action: RowMenuAction) => void;
}) {
  const press = useCallback(() => onOpen(row), [onOpen, row]);
  const menu = useCallback((action: RowMenuAction) => onMenu?.(row, action), [onMenu, row]);
  return (
    <Animated.View layout={ROW_LAYOUT} entering={ROW_ENTER} style={{ marginHorizontal: ROW_INSET }}>
      <ConversationRow row={row} current={current} onPress={press} width={ROW_W} onMenu={onMenu ? menu : undefined} />
      {separator ? <Separator /> : null}
    </Animated.View>
  );
});

function Separator() {
  const { colors: c } = useTheme();
  return (
    <View
      style={{ height: StyleSheet.hairlineWidth, marginLeft: ROW_TEXT_INSET, marginRight: space.sm, backgroundColor: c.separator }}
    />
  );
}

/** Sprouty's row before its DM is listed: its name and plant, nothing said yet. */
function standIn(sprouty: BotView, sessionId: string | null): BotConversationSummary {
  return {
    session_id: sessionId ?? '',
    kind: 'direct',
    title: null,
    owner_bot_id: sprouty.id,
    lead_bot_id: sprouty.id,
    members: [{ bot_id: sprouty.id, role: 'owner', position: 0 }],
    last_message: null,
    attention: 'idle',
    pending_requests: 0,
    last_activity_at: '',
  };
}

const useStyles = makeStyles((c) => ({
  section: { paddingTop: space.xs, paddingBottom: space.sm },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: ROW_INSET * 2 + 2,
    paddingRight: ROW_INSET,
  },
  headTitle: { ...typo.footnote, fontWeight: weight.semibold, color: c.secondaryLabel, flex: 1 },
  // a full 44-pt target without making the header row taller
  addBtn: { width: HIT, height: HIT, marginVertical: -6, alignItems: 'center', justifyContent: 'center' },
  textRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 36,
    marginHorizontal: ROW_INSET,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    ...squircle,
  },
  moreText: { ...typo.subheadline, color: c.accent },
  archivedText: { ...typo.subheadline, color: c.secondaryLabel },
}));
