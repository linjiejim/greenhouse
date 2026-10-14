/**
 * The drawer (PRD §6.2): the conversation directory and, pinned to the bottom, the module bar.
 *
 *  - Top: a search field (narrows every section) and 「新会话」 (long press: a new room).
 *  - The Agent area, with no heading and never folded: the main Agent first (taller row, larger
 *    plant), then my other Agents, then other members' public Agents I talk to. A row opens its
 *    Agent thread (made on first use). The plant thinks while its Agent answers and waits while
 *    it needs me.
 *  - 房间 (with ＋ for a new room), then 会话: pinned, today, and 「更早」 folded.
 *  - 已归档: archived chats and rooms on demand, each can come back.
 *  - Rows show a name and one signal on the right: the needs-you count > muted > running >
 *    unread (src/data/directory.ts); never a message preview. Every row has a long-press menu
 *    with the same actions as its conversation's ⋯.
 *  - The module bar: 对话 and 更多 (Agents, 运行, 设置) — 知识库, 表格 and 应用 join it when
 *    their screens come (and only for members who have them).
 *
 * Opening a conversation replaces the one on screen (no back stack; the stack cross-fades) and
 * closes the drawer. The directory refreshes every time the drawer opens.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useDrawerStatus, type DrawerContentComponentProps } from 'expo-router/drawer';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { archiveAgent } from '../api/agents';
import {
  createConversation,
  deleteConversation,
  exportConversation,
  listConversations,
  markRead,
  removeMember,
  updateConversation,
} from '../api/conversations';
import { directorySections, moodOf, signalOf, type AgentRow, type RowSignal } from '../data/directory';
import { useT } from '../lib/i18n';
import { shareTextFile } from '../lib/share-file';
import type { Conversation, UpdateConversationInput } from '../shared/contract';
import { useAuth } from '../store/auth';
import { useWorkspace } from '../store/workspace';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { AgentAvatar } from '../ui/agent-avatar';
import { Icon, Spinner, Touchable, type IconName } from '../ui/core';
import { alertError, confirmAction, promptText } from '../ui/dialogs';
import { DRAWER_W } from '../ui/drawer';
import { useFontScaleKey } from '../ui/font-scale';
import { NativeMenu, menuSections, type MenuItem } from '../ui/menu';
import { toast } from '../ui/toast';
import { openConversation, openMainThread, openNewChat } from './nav';
import { useHomeSurface } from './surface';

/** Rows sit inset in the panel; their menus get this width up front. */
const ROW_INSET = space.sm;
const ROW_W = DRAWER_W - ROW_INSET * 2;
/** Agents shown before 「全部 Agents」. */
const AGENTS_SHOWN = 6;

export function DrawerContent({ navigation }: DrawerContentComponentProps) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const fontKey = useFontScaleKey();
  const me = useAuth((s) => s.user);
  const agents = useWorkspace((s) => s.agents);
  const publicAgents = useWorkspace((s) => s.publicAgents);
  const conversations = useWorkspace((s) => s.conversations);
  const next = useWorkspace((s) => s.next);
  const loadFailed = useWorkspace((s) => s.loadFailed);
  const current = useHomeSurface((s) => s.conversationId);
  const onNewChat = useHomeSurface((s) => s.newChat);
  const [search, setSearch] = useState('');
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archived, setArchived] = useState<Conversation[] | null>(null);

  // Pick up what changed since the last look.
  const status = useDrawerStatus();
  useEffect(() => {
    if (status === 'open') void useWorkspace.getState().refresh();
  }, [status]);

  const sections = useMemo(
    () =>
      directorySections({
        agents: agents ?? [],
        publicAgents,
        conversations: conversations ?? [],
        untitled: t('conversation.untitled'),
        query: search,
        now: Date.now(),
        timeZone: me?.timezone,
      }),
    [agents, publicAgents, conversations, t, search, me?.timezone],
  );
  const searching = !!search.trim();

  const close = useCallback(() => navigation.closeDrawer(), [navigation]);
  const later = useCallback((fn: () => void) => setTimeout(fn, 160), []);

  const open = useCallback(
    (conversation: Conversation) => {
      close();
      if (conversation.id !== current) openConversation(router, { id: conversation.id, title: conversation.title });
    },
    [close, current, router],
  );

  const openAgent = useCallback(
    async (row: AgentRow) => {
      close();
      if (row.conversation) {
        if (row.conversation.id !== current) {
          if (row.conversation.kind === 'main') openMainThread(router);
          else openConversation(router, { id: row.conversation.id, title: row.agent.name });
        }
        return;
      }
      if ('is_main' in row.agent && row.agent.is_main) {
        openMainThread(router);
        return;
      }
      const made = await createConversation({ kind: 'direct', agent_id: row.agent.id });
      if (!made.ok) {
        alertError(t('directory.openFailed'), made.message || undefined);
        return;
      }
      useWorkspace.getState().putConversation(made.data);
      openConversation(router, { id: made.data.id, title: row.agent.name });
    },
    [close, current, router, t],
  );

  const newChat = useCallback(() => {
    close();
    if (!onNewChat) openNewChat(router, { compose: true });
  }, [close, onNewChat, router]);
  const newRoom = useCallback(() => {
    close();
    later(() => router.push('/new-room'));
  }, [close, later, router]);
  const go = useCallback(
    (path: '/agents' | '/runs' | '/settings') => {
      close();
      later(() => router.push(path));
    },
    [close, later, router],
  );

  const loadArchived = useCallback(async () => {
    const page = await listConversations({ archived: true, limit: 100 });
    setArchived(page.ok ? page.data.items : []);
  }, []);
  useEffect(() => {
    if (archivedOpen) void loadArchived();
  }, [archivedOpen, loadArchived]);

  /* ---------- row menus (the same actions as the conversation's ⋯) ---------- */
  const update = useCallback(
    async (conversation: Conversation, input: UpdateConversationInput) => {
      useWorkspace.getState().patchConversation(conversation.id, input as Partial<Conversation>);
      const result = await updateConversation(conversation.id, input);
      if (!result.ok) {
        void useWorkspace.getState().refreshConversations();
        alertError(t('row.saveFailed'), result.message || undefined);
        return false;
      }
      return true;
    },
    [t],
  );

  const onConversationMenu = useCallback(
    async (conversation: Conversation, id: string) => {
      const name = conversation.title || t('conversation.untitled');
      switch (id) {
        case 'pin':
        case 'unpin':
          await update(conversation, { pinned: id === 'pin' });
          return;
        case 'mute':
        case 'unmute':
          await update(conversation, { muted: id === 'mute' });
          return;
        case 'markRead':
          useWorkspace.getState().patchConversation(conversation.id, { last_read_seq: conversation.last_seq, unread: 0 });
          void markRead(conversation.id, conversation.last_seq).then(() => void useWorkspace.getState().refreshSummary());
          return;
        case 'rename': {
          const nextTitle = await promptText({ title: t('row.renameTitle'), defaultValue: conversation.title, confirmLabel: t('common.save') });
          if (nextTitle && nextTitle !== conversation.title) await update(conversation, { title: nextTitle });
          return;
        }
        case 'export': {
          const result = await exportConversation(conversation.id);
          if (!result.ok || !(await shareTextFile(result.data.filename, result.data.markdown, 'text/markdown'))) {
            alertError(t('row.exportFailed'));
          }
          return;
        }
        case 'archive':
          if (await update(conversation, { archived: true })) {
            toast(t('row.archived'), 'archive');
            if (conversation.id === current) openMainThread(router);
          }
          return;
        case 'unarchive': {
          const result = await updateConversation(conversation.id, { archived: false });
          if (!result.ok) {
            alertError(t('row.saveFailed'), result.message || undefined);
            return;
          }
          useWorkspace.getState().putConversation(result.data);
          void loadArchived();
          return;
        }
        case 'delete': {
          const ok = await confirmAction({
            title: t('row.deleteTitle', { name }),
            message: t('row.deleteHint'),
            confirmLabel: t('row.delete'),
            destructive: true,
          });
          if (!ok) return;
          const result = await deleteConversation(conversation.id);
          if (!result.ok) {
            alertError(t('row.deleteFailed'), result.message || undefined);
            return;
          }
          useWorkspace.getState().dropConversation(conversation.id);
          toast(t('row.deleted'), 'trash');
          if (conversation.id === current) openMainThread(router);
          return;
        }
        case 'leave': {
          const ok = await confirmAction({
            title: t('conversation.leaveTitle', { name }),
            message: t('conversation.leaveHint'),
            confirmLabel: t('conversation.leave'),
            destructive: true,
          });
          if (!ok || !me) return;
          const result = await removeMember(conversation.id, me.id);
          if (!result.ok) {
            alertError(t('conversation.leaveFailed'), result.message || undefined);
            return;
          }
          useWorkspace.getState().dropConversation(conversation.id);
          if (conversation.id === current) openMainThread(router);
          return;
        }
      }
    },
    [t, update, current, router, loadArchived, me],
  );

  const onAgentMenu = useCallback(
    async (row: AgentRow, id: string) => {
      switch (id) {
        case 'newChat':
          close();
          openNewChat(router, { agent: 'is_main' in row.agent && row.agent.is_main ? undefined : row.agent.id, compose: true });
          return;
        case 'profile':
          close();
          later(() => router.push({ pathname: '/agents/[id]', params: { id: row.agent.id } }));
          return;
        case 'computer':
          close();
          later(() => router.push({ pathname: '/computer', params: { agent: row.agent.id } }));
          return;
        case 'archiveAgent': {
          const ok = await confirmAction({
            title: t('agents.archiveTitle', { name: row.agent.name }),
            message: t('agents.archiveHint'),
            confirmLabel: t('row.archive'),
          });
          if (!ok) return;
          const result = await archiveAgent(row.agent.id);
          if (!result.ok) {
            alertError(t('agents.archiveFailed'), result.message || undefined);
            return;
          }
          toast(t('agents.archived', { name: row.agent.name }), 'archive');
          void useWorkspace.getState().refresh();
          if (row.conversation?.id === current) openMainThread(router);
          return;
        }
        default:
          if (row.conversation) await onConversationMenu(row.conversation, id);
      }
    },
    [close, later, router, t, current, onConversationMenu],
  );

  const computers = !!me?.modules.computer && !!me?.capabilities.sandbox;
  const menus = useMemo(() => {
    const toggles = (conversation: Conversation | null): MenuItem[] =>
      conversation
        ? [
            conversation.muted
              ? { id: 'unmute', title: t('row.unmute'), icon: 'bell' }
              : { id: 'mute', title: t('row.mute'), icon: 'bellSlash' },
            ...(conversation.unread > 0 ? [{ id: 'markRead', title: t('row.markRead'), icon: 'checkCircle' as const }] : []),
          ]
        : [];
    return {
      agent: (row: AgentRow): MenuItem[] => {
        const mine = !('owner' in row.agent);
        const isMain = 'is_main' in row.agent && row.agent.is_main;
        return menuSections([
          [
            { id: 'newChat', title: t('conversation.newChatWith'), icon: 'compose' },
            { id: 'profile', title: t('conversation.agentProfile'), icon: 'person' },
            ...(computers ? [{ id: 'computer', title: t('computer.open'), icon: 'computer' as const }] : []),
          ],
          toggles(row.conversation),
          mine && !isMain ? [{ id: 'archiveAgent', title: t('row.archive'), icon: 'archive' }] : [],
        ]);
      },
      room: (room: Conversation): MenuItem[] =>
        menuSections([
          [...toggles(room), { id: 'rename', title: t('row.rename'), icon: 'pen' }, { id: 'export', title: t('row.export'), icon: 'share' }],
          [{ id: 'leave', title: t('conversation.leave'), icon: 'logout', destructive: true }],
        ]),
      chat: (chat: Conversation): MenuItem[] =>
        menuSections([
          [
            chat.pinned ? { id: 'unpin', title: t('row.unpin'), icon: 'pinOff' } : { id: 'pin', title: t('row.pin'), icon: 'pin' },
            { id: 'rename', title: t('row.rename'), icon: 'pen' },
            { id: 'export', title: t('row.export'), icon: 'share' },
            { id: 'archive', title: t('row.archive'), icon: 'archive' },
          ],
          [{ id: 'delete', title: t('row.delete'), icon: 'trash', destructive: true }],
        ]),
      archived: (): MenuItem[] => [{ id: 'unarchive', title: t('row.unarchive'), icon: 'archive' }],
    };
  }, [t, computers]);

  const agentRows = [...sections.agents, ...sections.shared];
  const visibleAgents = searching ? agentRows : agentRows.slice(0, AGENTS_SHOWN);
  const showEarlier = earlierOpen || searching;
  const archivedRows = (archived ?? []).filter((item) =>
    !searching ? true : (item.title || t('conversation.untitled')).toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + space.sm }]}>
      <View style={styles.topRow}>
        <View style={styles.search}>
          <Icon name="search" size={16} color={c.secondaryLabel} />
          <TextInput
            key={fontKey}
            maxFontSizeMultiplier={1.3}
            value={search}
            onChangeText={setSearch}
            placeholder={t('directory.search')}
            placeholderTextColor={c.placeholder}
            returnKeyType="search"
            clearButtonMode="while-editing"
            autoCorrect={false}
            style={styles.searchInput}
            accessibilityLabel={t('directory.search')}
          />
        </View>
        <NativeMenu
          trigger="longPress"
          fill={false}
          items={[
            { id: 'chat', title: t('conversation.newChat'), icon: 'compose' },
            { id: 'room', title: t('directory.newRoom'), icon: 'users' },
          ]}
          onSelect={(id) => (id === 'room' ? newRoom() : newChat())}
        >
          <Pressable
            onPress={newChat}
            accessibilityRole="button"
            accessibilityLabel={t('conversation.newChat')}
            accessibilityActions={[{ name: 'room', label: t('directory.newRoom') }]}
            onAccessibilityAction={(e) => {
              if (e.nativeEvent.actionName === 'room') newRoom();
            }}
            style={({ pressed }) => [styles.topBtn, pressed && styles.pressedDim]}
          >
            <Icon name="compose" size={22} color={c.label} />
          </Pressable>
        </NativeMenu>
      </View>

      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {agents === null && !loadFailed ? <Spinner style={styles.loading} /> : null}
        {loadFailed && agents === null ? (
          <Touchable onPress={() => void useWorkspace.getState().refresh()} style={styles.failed} accessibilityRole="button">
            <Icon name="alert" size={15} color={c.red} />
            <Text style={styles.failedText}>{t('directory.loadFailed')}</Text>
            <Text style={styles.retry}>{t('common.retry')}</Text>
          </Touchable>
        ) : null}

        {/* the Agent area: no heading, never folded */}
        {sections.main ? (
          <AgentRowView
            row={sections.main}
            main
            current={!!sections.main.conversation && sections.main.conversation.id === current}
            menu={menus.agent(sections.main)}
            onPress={() => void openAgent(sections.main!)}
            onMenu={(id) => void onAgentMenu(sections.main!, id)}
          />
        ) : null}
        {visibleAgents.map((row) => (
          <AgentRowView
            key={row.agent.id}
            row={row}
            current={!!row.conversation && row.conversation.id === current}
            menu={menus.agent(row)}
            onPress={() => void openAgent(row)}
            onMenu={(id) => void onAgentMenu(row, id)}
          />
        ))}
        {!searching && agentRows.length > AGENTS_SHOWN ? (
          <PlainRow icon="sparkle" label={t('directory.allAgents')} onPress={() => go('/agents')} />
        ) : null}

        <SectionHead title={t('directory.rooms')} action={{ label: t('directory.newRoom'), onPress: newRoom }} />
        {sections.rooms.map((room) => (
          <ConversationRowView
            key={room.id}
            conversation={room}
            icon="users"
            current={room.id === current}
            untitled={t('conversation.untitled')}
            menu={menus.room(room)}
            onPress={() => open(room)}
            onMenu={(id) => void onConversationMenu(room, id)}
          />
        ))}

        <SectionHead title={t('directory.chats')} />
        {sections.pinned.map((chat) => (
          <ConversationRowView
            key={chat.id}
            conversation={chat}
            icon="pin"
            current={chat.id === current}
            untitled={t('conversation.untitled')}
            menu={menus.chat(chat)}
            onPress={() => open(chat)}
            onMenu={(id) => void onConversationMenu(chat, id)}
          />
        ))}
        {sections.today.map((chat) => (
          <ConversationRowView
            key={chat.id}
            conversation={chat}
            icon="msg"
            current={chat.id === current}
            untitled={t('conversation.untitled')}
            menu={menus.chat(chat)}
            onPress={() => open(chat)}
            onMenu={(id) => void onConversationMenu(chat, id)}
          />
        ))}
        {sections.earlier.length || (showEarlier && next) ? (
          <FoldRow
            label={t('directory.earlier')}
            count={sections.earlier.length}
            open={showEarlier}
            onPress={() => setEarlierOpen((value) => !value)}
          />
        ) : null}
        {showEarlier
          ? sections.earlier.map((chat) => (
              <ConversationRowView
                key={chat.id}
                conversation={chat}
                icon="msg"
                indent
                current={chat.id === current}
                untitled={t('conversation.untitled')}
                menu={menus.chat(chat)}
                onPress={() => open(chat)}
                onMenu={(id) => void onConversationMenu(chat, id)}
              />
            ))
          : null}
        {showEarlier && next ? (
          <PlainRow icon="chevD" label={t('directory.showEarlier')} indent onPress={() => void useWorkspace.getState().loadMoreConversations()} />
        ) : null}
        {!sections.pinned.length && !sections.today.length && !sections.earlier.length && conversations ? (
          <Text style={styles.empty}>{searching ? t('directory.noMatches') : t('directory.noChats')}</Text>
        ) : null}

        <FoldRow label={t('directory.archived')} open={archivedOpen} onPress={() => setArchivedOpen((value) => !value)} />
        {archivedOpen
          ? archivedRows.map((item) => (
              <ConversationRowView
                key={item.id}
                conversation={item}
                icon={item.kind === 'room' ? 'users' : 'msg'}
                indent
                current={item.id === current}
                untitled={t('conversation.untitled')}
                menu={menus.archived()}
                onPress={() => open(item)}
                onMenu={(id) => void onConversationMenu(item, id)}
              />
            ))
          : null}
        {archivedOpen && archived && !archivedRows.length ? (
          <Text style={styles.empty}>{t('directory.noneArchived')}</Text>
        ) : null}
        <View style={{ height: space.lg }} />
      </ScrollView>

      {/* the module bar: 对话 · 更多 (知识库, 表格 and 应用 join it with their screens) */}
      <View key={fontKey} style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
        <BarItem icon="msgs" label={t('nav.chat')} current onPress={close} />
        <NativeMenu
          items={[
            { id: '/agents', title: t('nav.agents'), icon: 'sparkle' },
            { id: '/runs', title: t('nav.runs'), icon: 'runs' },
            { id: '/settings', title: t('nav.settings'), icon: 'gear' },
          ]}
          onSelect={(id) => go(id as '/agents' | '/runs' | '/settings')}
          style={styles.barSlot}
        >
          <BarItem icon="more" label={t('nav.more')} />
        </NativeMenu>
      </View>
    </View>
  );
}

/* ----------------------------- rows ----------------------------- */

function SignalView({ signal }: { signal: RowSignal }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  if (!signal) return null;
  switch (signal.kind) {
    case 'needs':
      return (
        <View style={styles.needs} accessibilityLabel={t('directory.needsYou', { n: signal.count })}>
          <Text style={styles.needsText}>{signal.count > 99 ? '99+' : signal.count}</Text>
        </View>
      );
    case 'muted':
      return <Icon name="bellSlash" size={13} color={c.tertiaryLabel} />;
    case 'running':
      return <Spinner style={styles.running} />;
    case 'unread':
      return <View style={styles.unread} accessibilityLabel={t('directory.unread')} />;
  }
}

function signalLabel(t: ReturnType<typeof useT>, signal: RowSignal): string {
  if (!signal) return '';
  if (signal.kind === 'needs') return t('directory.needsYou', { n: signal.count });
  if (signal.kind === 'muted') return t('directory.muted');
  if (signal.kind === 'running') return t('directory.running');
  return t('directory.unread');
}

function AgentRowView({
  row,
  main = false,
  current,
  menu,
  onPress,
  onMenu,
}: {
  row: AgentRow;
  main?: boolean;
  current: boolean;
  menu: MenuItem[];
  onPress: () => void;
  onMenu: (id: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const fontKey = useFontScaleKey();
  const signal = signalOf(row.conversation);
  const owner = 'owner' in row.agent ? row.agent.owner.name : null;
  return (
    <NativeMenu trigger="longPress" items={menu} onSelect={onMenu} width={ROW_W} style={styles.rowSlot}>
      <Pressable
        key={fontKey}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={[row.agent.name, owner ? t('directory.sharedBy', { name: owner }) : '', signalLabel(t, signal)].filter(Boolean).join(t('common.listSep'))}
        accessibilityState={{ selected: current }}
        style={({ pressed }) => [
          styles.row,
          main ? styles.mainRow : styles.agentRow,
          current && { backgroundColor: c.tertiaryFill },
          pressed && { backgroundColor: c.fill },
        ]}
      >
        <AgentAvatar agent={row.agent} size={main ? 36 : 26} state={moodOf(row.conversation)} />
        <View style={styles.rowTexts}>
          <Text numberOfLines={1} style={[main ? styles.mainName : styles.rowText, current && styles.rowTextActive]}>
            {row.agent.name}
          </Text>
          {owner ? (
            <Text numberOfLines={1} style={styles.rowSub}>
              {t('directory.sharedBy', { name: owner })}
            </Text>
          ) : null}
        </View>
        <SignalView signal={signal} />
      </Pressable>
    </NativeMenu>
  );
}

function ConversationRowView({
  conversation,
  icon,
  indent = false,
  current,
  untitled,
  menu,
  onPress,
  onMenu,
}: {
  conversation: Conversation;
  icon: IconName;
  indent?: boolean;
  current: boolean;
  untitled: string;
  menu: MenuItem[];
  onPress: () => void;
  onMenu: (id: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const fontKey = useFontScaleKey();
  const signal = signalOf(conversation);
  const title = conversation.title || untitled;
  return (
    <NativeMenu trigger="longPress" items={menu} onSelect={onMenu} width={ROW_W} style={styles.rowSlot}>
      <Pressable
        key={fontKey}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={[title, signalLabel(t, signal)].filter(Boolean).join(t('common.listSep'))}
        accessibilityState={{ selected: current }}
        style={({ pressed }) => [
          styles.row,
          indent && styles.indent,
          current && { backgroundColor: c.tertiaryFill },
          pressed && { backgroundColor: c.fill },
        ]}
      >
        <Icon name={icon} size={16} color={c.secondaryLabel} />
        <Text numberOfLines={1} style={[styles.rowText, styles.grow, current && styles.rowTextActive]}>
          {title}
        </Text>
        <SignalView signal={signal} />
      </Pressable>
    </NativeMenu>
  );
}

function SectionHead({ title, action }: { title: string; action?: { label: string; onPress: () => void } }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const fontKey = useFontScaleKey();
  return (
    <View key={fontKey} style={styles.sectionHead}>
      <Text accessibilityRole="header" style={styles.sectionText}>
        {title}
      </Text>
      {action ? (
        <Touchable onPress={action.onPress} style={styles.sectionAction} accessibilityRole="button" accessibilityLabel={action.label}>
          <Icon name="plus" size={16} color={c.secondaryLabel} />
        </Touchable>
      ) : null}
    </View>
  );
}

function FoldRow({ label, count, open, onPress }: { label: string; count?: number; open: boolean; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const fontKey = useFontScaleKey();
  return (
    <Pressable
      key={fontKey}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={count ? `${label}, ${count}` : label}
      accessibilityState={{ expanded: open }}
      style={({ pressed }) => [styles.rowSlot, styles.fold, pressed && { backgroundColor: c.fill }]}
    >
      <Text numberOfLines={1} style={styles.foldText}>
        {label}
      </Text>
      {count ? <Text style={styles.foldCount}>{count}</Text> : null}
      <Icon name={open ? 'chevD' : 'chevR'} size={12} weight="semibold" color={c.tertiaryLabel} />
    </Pressable>
  );
}

function PlainRow({ icon, label, indent, onPress }: { icon: IconName; label: string; indent?: boolean; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.rowSlot, styles.row, indent && styles.indent, pressed && { backgroundColor: c.fill }]}
    >
      <Icon name={icon} size={15} color={c.secondaryLabel} />
      <Text numberOfLines={1} style={[styles.rowText, styles.grow, { color: c.secondaryLabel }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function BarItem({ icon, label, current, onPress }: { icon: IconName; label: string; current?: boolean; onPress?: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const content = (
    <>
      <Icon name={icon} size={22} color={current ? c.accent : c.label} />
      <Text numberOfLines={1} style={[styles.barLabel, current && { color: c.accent }]}>
        {label}
      </Text>
    </>
  );
  // without onPress it is a menu's trigger: the menu owns the touch
  return onPress ? (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.barSlot, styles.barItem, pressed && { opacity: 0.5 }]}
      accessibilityRole="button"
      accessibilityState={{ selected: !!current }}
      accessibilityLabel={label}
    >
      {content}
    </Pressable>
  ) : (
    <View style={styles.barItem} accessible accessibilityRole="button" accessibilityLabel={label}>
      {content}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.sm },
  search: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    height: 38,
    paddingHorizontal: space.md - 2,
    borderRadius: 19,
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  searchInput: { flex: 1, ...typo.body, color: c.label, paddingVertical: 0 },
  topBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  pressedDim: { opacity: 0.55 },
  list: { flex: 1 },
  loading: { marginTop: space.lg },
  failed: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: HIT, marginHorizontal: space.lg },
  failedText: { flex: 1, ...typo.footnote, color: c.red },
  retry: { ...typo.footnote, fontWeight: weight.semibold, color: c.accent },
  rowSlot: { marginHorizontal: ROW_INSET },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    minHeight: HIT,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    ...squircle,
  },
  mainRow: { minHeight: 56, paddingVertical: space.xs },
  agentRow: { minHeight: HIT },
  indent: { paddingLeft: space.xl + 4 },
  rowTexts: { flex: 1, minWidth: 0 },
  grow: { flex: 1 },
  rowText: { ...typo.body, color: c.label },
  mainName: { ...typo.headline, fontWeight: weight.semibold, color: c.label },
  rowTextActive: { fontWeight: weight.semibold },
  rowSub: { ...typo.caption1, color: c.secondaryLabel },
  needs: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.orange,
  },
  needsText: { ...typo.caption1, fontWeight: weight.semibold, color: c.onTint, fontVariant: ['tabular-nums'] },
  running: { transform: [{ scale: 0.75 }] },
  unread: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: c.accent },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.lg + 2,
    paddingRight: space.sm,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  sectionText: { flex: 1, ...typo.footnote, fontWeight: weight.semibold, color: c.secondaryLabel },
  sectionAction: { width: HIT, height: 32, alignItems: 'center', justifyContent: 'center' },
  fold: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    minHeight: HIT,
    marginTop: space.xs,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    ...squircle,
  },
  foldText: { flex: 1, ...typo.subheadline, fontWeight: weight.medium, color: c.secondaryLabel },
  foldCount: { ...typo.footnote, color: c.tertiaryLabel, fontVariant: ['tabular-nums'] },
  empty: { ...typo.footnote, color: c.tertiaryLabel, paddingHorizontal: space.lg + 2, paddingVertical: space.sm },
  bar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingTop: space.xs,
    paddingHorizontal: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.separator,
  },
  barSlot: { flex: 1 },
  barItem: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    minHeight: HIT + 6,
    paddingVertical: space.xs,
    borderRadius: radius.md,
    ...squircle,
  },
  barLabel: { ...typo.caption2, color: c.secondaryLabel },
}));
