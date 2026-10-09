/**
 * The tabs of a Bot's profile (./bot-profile-view.tsx) — everything about one
 * Bot in one place (2026-10: the thread's ⋯ used to split it between "Bot
 * Profile", "Conversation Info" and "Invite a Bot"):
 *
 *  - 概览 `OverviewTab` — how it works (its instructions, first), what it is
 *    for, its model, its private reference folder, the connectors it is kept
 *    to (when narrowed on the web), the other Bots that joined its DM (a
 *    guest can be removed), archive;
 *  - 记忆 `MemoryTab` — what it remembers lately (the DM's rolling summary)
 *    and what it alone remembers about the member (each can be forgotten);
 *  - 笔记 `NotesTab` — the DM's shared notes: open first, done folded; tick,
 *    add, delete (the web's info panel, now here);
 *  - 定时 `ScheduleTab` — the automations that run as this Bot: pause / resume,
 *    run now, delete; a new one is asked for in its thread (the Bot raises the
 *    approval card);
 *  - 对话 `ChatsTab` — the member's separate conversations with it (fresh
 *    chats, its automation runs: `GET /api/sessions?profile=`).
 *
 * Plain RN lists from the list kit, loaded when a tab first shows; every write
 * is applied at once and rolled back with an alert when refused.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  addNote,
  deleteBotMemory,
  deleteNote,
  listBotFiles,
  listBotMemories,
  updateNote,
  type BotFilesView,
} from '../../api/bots';
import { deleteAutomation, listAutomations, runAutomation, setAutomationEnabled, type Automation } from '../../api/automations';
import { fetchSessionsPage, type Session } from '../../api/sessions';
import { Markdown } from '../../chat/markdown';
import { parseMs, relativeTime } from '../../lib/format';
import { entityRoute, parseEntityUrl } from '../../lib/entity-links';
import { useLocale, useT, type TFunction } from '../../lib/i18n';
import type { BotSharedNoteView, BotView } from '../../shared/bots';
import type { BotMemoryView } from '../../shared/bots-wire';
import { makeStyles, space, squircle, typo, useTheme, weight } from '../../theme';
import { Icon, Spinner } from '../../ui/core';
import { alertError, confirmAction, promptText } from '../../ui/dialogs';
import { ListCard, ListRow, ListSection, ListSectionFooter, ListSectionHeader } from '../../ui/list';
import { NativeMenu, menuSections, type MenuItem } from '../../ui/menu';
import { toast } from '../../ui/toast';
import { openChat, openThread } from '../nav';
import { BotAvatar } from '../ui/bot-avatar';
import { useAuth } from '../../store/auth';
import { useBots } from '../store';
import { memberRemovable, orderedNotes, sortedMembers } from './member-model';
import { matchesProfile, profileQuery, profileRefs } from './profile-refs';
import { scheduleWords } from './schedule-words';
import { useConversationInfo } from './use-conversation-info';

/** Instructions longer than this fold behind 显示全部, to this height. */
const FOLD_LINES = 8;
const FOLD_CHARS = 360;
const FOLD_HEIGHT = 220;

export type ProfileTab = 'overview' | 'memory' | 'notes' | 'schedule' | 'chats';
export const PROFILE_TABS: readonly ProfileTab[] = ['overview', 'memory', 'notes', 'schedule', 'chats'];

/* ───────────────────────────── 概览 ───────────────────────────── */

export function OverviewTab({ bot, main, onArchive }: { bot: BotView; main: boolean; onArchive: () => void }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [expanded, setExpanded] = useState(false);
  // the whole text's height: the folded block shows at most FOLD_HEIGHT of it
  const [fullHeight, setFullHeight] = useState(0);
  const instructions = bot.instructions.trim();
  const folds = instructions.split('\n').length > FOLD_LINES || instructions.length > FOLD_CHARS;
  const archived = bot.status === 'archived';
  const files = useLoad(useCallback(() => listBotFiles(bot.id).then((r) => (r.ok ? r.value : null)), [bot.id]));
  const dm = bot.dm_session_id;

  return (
    <>
      {instructions ? (
        <View style={styles.section}>
          <ListSectionHeader title={t('bots.manage.instructions')} />
          <ListCard style={styles.card}>
            {folds && !expanded ? (
              // laid out at full height and clipped from outside: a height limit on the text itself makes
              // TextKit clip its last line mid-word instead of wrapping it
              <View style={{ height: Math.min(FOLD_HEIGHT, fullHeight || FOLD_HEIGHT), overflow: 'hidden' }}>
                <View style={styles.unfolded} onLayout={(e) => setFullHeight(e.nativeEvent.layout.height)}>
                  <Markdown source={instructions} />
                </View>
              </View>
            ) : (
              <Markdown source={instructions} />
            )}
            {folds ? (
              <Pressable onPress={() => setExpanded((v) => !v)} accessibilityRole="button" hitSlop={space.sm}>
                <Text style={styles.toggle}>{expanded ? t('bots.manage.showLess') : t('bots.manage.showAll')}</Text>
              </Pressable>
            ) : null}
          </ListCard>
        </View>
      ) : null}
      {bot.description.trim() ? (
        <ListSection header={t('bots.manage.purpose')}>
          <ListRow title={bot.description.trim()} titleLines={6} />
        </ListSection>
      ) : null}
      <ListSection header={t('bots.profile.details')}>
        <ListRow title={t('bots.profile.model')} value={bot.model_id || t('bots.profile.defaultModel')} />
        <ListRow title={t('bots.profile.files')} value={files.value ? String(files.value.docs.length) : undefined} />
        {/* only when narrowed on the web (null = every connector the member can use) */}
        {bot.connectors ? (
          <ListRow
            title={t('bots.profile.connectors')}
            value={bot.connectors.length ? bot.connectors.join(', ') : t('bots.profile.noConnectors')}
          />
        ) : null}
      </ListSection>
      {files.value && files.value.docs.length ? <FileList files={files.value} /> : null}
      {dm ? <Guests sessionId={dm} ownerId={bot.id} /> : null}
      {main ? (
        <ListSectionFooter text={t('bots.manage.mainBot', { name: bot.name })} style={styles.closing} />
      ) : !archived ? (
        <ListSection>
          <ListRow title={t('bots.manage.archive')} destructive onPress={onArchive} />
        </ListSection>
      ) : null}
    </>
  );
}

/** The first documents of its private folder — each opens its preview. */
function FileList({ files }: { files: BotFilesView }) {
  const router = useRouter();
  return (
    <ListSection>
      {files.docs.slice(0, 5).map((doc) => {
        const ref = parseEntityUrl(doc.url);
        const href = ref ? entityRoute(ref) : null;
        return (
          <ListRow
            key={doc.id}
            icon="file"
            title={doc.title}
            subtitle={relativeTime(doc.updated_at)}
            accessory={href ? 'chevron' : 'none'}
            onPress={href ? () => router.push(href) : undefined}
          />
        );
      })}
    </ListSection>
  );
}

/** Other Bots that joined its DM (guests): remove one with a touch and hold. */
function Guests({ sessionId, ownerId }: { sessionId: string; ownerId: string }) {
  const t = useT();
  const info = useConversationInfo(sessionId);
  const detail = info.detail;
  const guests = detail ? sortedMembers(detail.members).filter((m) => m.bot_id !== ownerId) : [];
  const items = useMemo<MenuItem[]>(
    () => [{ id: 'remove', title: t('bots.manage.remove'), icon: 'personMinus', destructive: true }],
    [t],
  );
  if (!detail || !guests.length) return null;
  return (
    <ListSection header={t('bots.profile.guests')} footer={t('bots.profile.guestsFooter')}>
      {guests.map((member) =>
        memberRemovable(detail, member) ? (
          <NativeMenu
            key={member.bot_id}
            trigger="longPress"
            items={items}
            onSelect={(id) => id === 'remove' && void info.remove(member.bot_id)}
          >
            <GuestRow botId={member.bot_id} />
          </NativeMenu>
        ) : (
          <GuestRow key={member.bot_id} botId={member.bot_id} />
        ),
      )}
    </ListSection>
  );
}

function GuestRow({ botId, last }: { botId: string; last?: boolean }) {
  const t = useT();
  const bot = useBotView(botId);
  return (
    <ListRow
      leading={<BotAvatar bot={bot ?? null} size={30} />}
      title={bot?.name ?? t('bots.common.deletedBot')}
      subtitle={bot?.role}
      last={last}
    />
  );
}

/* ───────────────────────────── 记忆 ───────────────────────────── */

export function MemoryTab({ bot }: { bot: BotView }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const dm = bot.dm_session_id;
  return (
    <>
      {dm ? <Digest sessionId={dm} /> : null}
      <Memories bot={bot} />
      <Text style={[styles.note, styles.closing]}>{t('bots.profile.memoryHint', { name: bot.name })}</Text>
    </>
  );
}

function Digest({ sessionId }: { sessionId: string }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const info = useConversationInfo(sessionId);
  const digest = info.detail?.digest;
  if (!digest?.text?.trim()) return null;
  return (
    <View style={styles.section}>
      <ListSectionHeader title={t('bots.profile.lately')} />
      <ListCard style={styles.card}>
        <Text style={styles.body} selectable>
          {digest.text.trim()}
        </Text>
      </ListCard>
      {digest.updated_at ? (
        <ListSectionFooter text={t('bots.profile.updated', { time: relativeTime(digest.updated_at) })} />
      ) : null}
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
          <NativeMenu
            key={memory.id}
            trigger="longPress"
            items={items}
            onSelect={(id) => id === 'forget' && void forget(memory)}
          >
            <ListRow
              title={memory.title}
              subtitle={memory.content}
              subtitleLines={4}
              titleLines={2}
              accessory={memory.pinned ? <Icon name="pin" size={13} color={c.tertiaryLabel} /> : 'none'}
              accessibilityLabel={[memory.title, memory.content, memory.pinned ? t('bots.nav.pinnedA11y') : null]
                .filter(Boolean)
                .join(', ')}
              accessibilityActions={[{ name: 'forget', label: t('bots.manage.forget') }]}
              onAccessibilityAction={(e) => {
                if (e.nativeEvent.actionName === 'forget') void forget(memory);
              }}
            />
          </NativeMenu>
        ))
      )}
    </ListSection>
  );
}

/* ───────────────────────────── 笔记 ───────────────────────────── */

export function NotesTab({ bot }: { bot: BotView }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const dm = bot.dm_session_id;
  const info = useConversationInfo(dm ?? '');
  const [notes, setNotes] = useState<BotSharedNoteView[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  useEffect(() => {
    if (info.detail) setNotes(info.detail.notes);
  }, [info.detail]);

  // a refused write re-reads the conversation (its notes replace the guess)
  const write = useCallback(
    async (guess: (rows: BotSharedNoteView[]) => BotSharedNoteView[], send: () => Promise<{ ok: boolean }>) => {
      setNotes((rows) => (rows ? guess(rows) : rows));
      const result = await send();
      if (!result.ok) {
        alertError(t('bots.profile.noteFailed'));
        void info.reload();
      }
    },
    [info, t],
  );

  const add = useCallback(async () => {
    if (!dm) return;
    const title = await promptText({ title: t('bots.profile.newNote'), confirmLabel: t('common.save') });
    if (!title) return;
    const result = await addNote(dm, { title: title.slice(0, 80) });
    if (!result.ok) {
      alertError(t('bots.profile.noteFailed'), result.message || undefined);
      return;
    }
    setNotes((rows) => [result.value, ...(rows ?? [])]);
  }, [dm, t]);

  const toggle = useCallback(
    (note: BotSharedNoteView) => {
      if (!dm) return;
      const status = note.status === 'done' ? 'open' : 'done';
      void write(
        (rows) => rows.map((row) => (row.id === note.id ? { ...row, status } : row)),
        () => updateNote(dm, note.id, { status }),
      );
    },
    [dm, write],
  );

  const remove = useCallback(
    async (note: BotSharedNoteView) => {
      if (!dm) return;
      const ok = await confirmAction({
        title: t('bots.profile.deleteNote'),
        message: note.title,
        confirmLabel: t('common.delete'),
        destructive: true,
      });
      if (!ok) return;
      void write(
        (rows) => rows.filter((row) => row.id !== note.id),
        async () => {
          const result = await deleteNote(dm, note.id);
          return { ok: result.ok || (!result.ok && result.status === 404) };
        },
      );
    },
    [dm, t, write],
  );

  const items = useMemo<MenuItem[]>(
    () => menuSections([[{ id: 'delete', title: t('common.delete'), icon: 'trash', destructive: true }]]),
    [t],
  );

  if (!dm) return <Text style={[styles.note, styles.closing]}>{t('bots.profile.noThread')}</Text>;
  if (notes === null) {
    return info.load === 'error' ? (
      <ListSection>
        <ListRow title={t('bots.profile.loadFailed')} onPress={() => void info.reload()} />
      </ListSection>
    ) : (
      <ListCard style={[styles.pending, styles.inset]}>
        <Spinner />
      </ListCard>
    );
  }
  const ordered = orderedNotes(notes);
  const open = ordered.filter((n) => n.status === 'open');
  const done = ordered.filter((n) => n.status === 'done');
  const row = (note: BotSharedNoteView) => (
    <NativeMenu key={note.id} trigger="longPress" items={items} onSelect={(id) => id === 'delete' && void remove(note)}>
      <ListRow
        leading={
          <Pressable
            onPress={() => toggle(note)}
            hitSlop={space.sm}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: note.status === 'done' }}
            accessibilityLabel={note.title}
          >
            <Icon
              name={note.status === 'done' ? 'checkCircleFill' : 'circle'}
              size={22}
              color={note.status === 'done' ? c.accent : c.tertiaryLabel}
            />
          </Pressable>
        }
        leadingWidth={24}
        title={note.title}
        subtitle={note.body || undefined}
        subtitleLines={3}
        titleLines={2}
        accessory={note.pinned ? <Icon name="pin" size={13} color={c.tertiaryLabel} /> : 'none'}
      />
    </NativeMenu>
  );
  return (
    <>
      <ListSection header={t('bots.profile.openNotes')} footer={t('bots.profile.notesFooter', { name: bot.name })}>
        {open.length ? open.map(row) : [<ListRow key="none" title={t('bots.profile.noNotes')} />]}
        <ListRow key="add" icon="plus" title={t('bots.profile.addNote')} onPress={() => void add()} />
      </ListSection>
      {done.length ? (
        <ListSection>
          <ListRow
            title={t('bots.profile.doneNotes', { n: String(done.length) })}
            accessory={<Icon name={showDone ? 'chevD' : 'chevR'} size={12} weight="semibold" color={c.tertiaryLabel} />}
            onPress={() => setShowDone((v) => !v)}
          />
          {showDone ? done.map(row) : []}
        </ListSection>
      ) : null}
    </>
  );
}

/* ───────────────────────────── 定时 ───────────────────────────── */

export function ScheduleTab({ bot, main }: { bot: BotView; main: boolean }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const router = useRouter();
  const locale = useLocale();
  const me = useAuth((s) => s.user?.id);
  const refs = useMemo(() => profileRefs({ id: bot.id, main }), [bot.id, main]);
  const [rows, setRows] = useState<Automation[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const all = await listAutomations();
    if (!all) {
      setFailed(true);
      return;
    }
    setRows(all.filter((task) => task.user_id === me && matchesProfile(task.profile_id, refs)));
  }, [me, refs]);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (task: Automation, enabled: boolean) => {
      setRows((list) => list?.map((row) => (row.id === task.id ? { ...row, enabled } : row)) ?? null);
      if (!(await setAutomationEnabled(task.id, enabled))) {
        setRows((list) => list?.map((row) => (row.id === task.id ? { ...row, enabled: !enabled } : row)) ?? null);
        alertError(t('bots.profile.scheduleFailed'));
      }
    },
    [t],
  );
  const onMenu = useCallback(
    async (task: Automation, id: string) => {
      if (id === 'run') {
        if (await runAutomation(task.id)) toast(t('bots.profile.runStarted'), 'check');
        else alertError(t('bots.profile.scheduleFailed'));
      } else if (id === 'delete') {
        const ok = await confirmAction({
          title: t('bots.profile.deleteSchedule'),
          message: task.name,
          confirmLabel: t('common.delete'),
          destructive: true,
        });
        if (!ok) return;
        setRows((list) => list?.filter((row) => row.id !== task.id) ?? null);
        if (!(await deleteAutomation(task.id))) {
          alertError(t('bots.profile.scheduleFailed'));
          void load();
        }
      }
    },
    [load, t],
  );
  const items = useMemo<MenuItem[]>(
    () =>
      menuSections([
        [{ id: 'run', title: t('bots.profile.runNow'), icon: 'refresh' }],
        [{ id: 'delete', title: t('common.delete'), icon: 'trash', destructive: true }],
      ]),
    [t],
  );
  // a new automation is asked for in the thread: the Bot raises the approval card there
  const ask = useCallback(() => {
    if (bot.dm_session_id) openThread(router, { c: bot.dm_session_id, title: bot.name, compose: true }, 'dismissTo');
  }, [bot.dm_session_id, bot.name, router]);

  if (rows === null) {
    return failed ? (
      <ListSection>
        <ListRow title={t('bots.profile.loadFailed')} onPress={() => void load()} />
      </ListSection>
    ) : (
      <ListCard style={[styles.pending, styles.inset]}>
        <Spinner />
      </ListCard>
    );
  }
  return (
    <ListSection footer={t('bots.profile.scheduleFooter', { name: bot.name })}>
      {rows.map((task) => {
        const next = parseMs(task.next_run_at ?? '');
        return (
          <NativeMenu key={task.id} trigger="longPress" items={items} onSelect={(id) => void onMenu(task, id)}>
            <ListRow
              title={task.name}
              subtitle={[
                describeSchedule(task.schedule, t),
                task.enabled && next
                  ? t('bots.profile.nextRun', {
                      time: new Date(next).toLocaleString(locale, {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      }),
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              accessory={
                <Switch
                  value={task.enabled}
                  onValueChange={(v) => void toggle(task, v)}
                  trackColor={{ true: c.accent }}
                  accessibilityLabel={task.name}
                />
              }
            />
          </NativeMenu>
        );
      })}
      {bot.dm_session_id && bot.status === 'active' ? (
        <ListRow icon="plus" title={t('bots.profile.askSchedule', { name: bot.name })} onPress={ask} />
      ) : rows.length === 0 ? (
        <ListRow title={t('bots.profile.noSchedules')} />
      ) : null}
    </ListSection>
  );
}

/** "工作日 09:00" — or the cron itself when it isn't one of the builder's shapes. */
function describeSchedule(cron: string, t: TFunction): string {
  const words = scheduleWords(cron);
  if (!words) return cron;
  switch (words.kind) {
    case 'daily':
      return t('bots.profile.schedDaily', { time: words.time });
    case 'weekdays':
      return t('bots.profile.schedWeekdays', { time: words.time });
    case 'weekly': {
      const names = t('bots.profile.weekdayNames').split(',');
      const days = words.days.map((d) => names[d] ?? String(d)).join(t('bots.profile.daySep'));
      return t('bots.profile.schedWeekly', { days, time: words.time });
    }
    case 'monthly':
      return t('bots.profile.schedMonthly', { day: words.day, time: words.time });
  }
}

/* ───────────────────────────── 对话 ───────────────────────────── */

export function ChatsTab({ bot, main }: { bot: BotView; main: boolean }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const router = useRouter();
  const profile = profileQuery({ id: bot.id, main });
  const [rows, setRows] = useState<Session[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    const page = await fetchSessionsPage({ limit: 30, profile });
    if (!page) setFailed(true);
    else setRows(page.sessions);
  }, [profile]);
  useEffect(() => {
    void load();
  }, [load]);

  if (rows === null) {
    return failed ? (
      <ListSection>
        <ListRow title={t('bots.profile.loadFailed')} onPress={() => void load()} />
      </ListSection>
    ) : (
      <ListCard style={[styles.pending, styles.inset]}>
        <Spinner />
      </ListCard>
    );
  }
  return (
    <ListSection footer={t('bots.profile.chatsFooter', { name: bot.name })}>
      {rows.length === 0 ? (
        <ListRow title={t('bots.profile.noChats')} />
      ) : (
        rows.map((s) => (
          <ListRow
            key={s.id}
            title={s.title || t('chat.newConversation')}
            subtitle={relativeTime(s.updated_at || s.created_at)}
            accessory="chevron"
            onPress={() => openChat(router, { id: s.id, title: s.title ?? '', ro: s.is_owner === false }, 'dismissTo')}
          />
        ))
      )}
    </ListSection>
  );
}

/* ───────────────────────────── shared ───────────────────────────── */

/** One async read on mount (and when its loader changes); `value` null until it lands or when it fails. */
function useLoad<T>(loader: () => Promise<T | null>): { value: T | null } {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    void loader().then((v) => {
      if (live) setValue(v);
    });
    return () => {
      live = false;
    };
  }, [loader]);
  return { value };
}

function useBotView(botId: string): BotView | undefined {
  return useBots((s) => s.byId[botId]);
}

const useStyles = makeStyles((c) => ({
  section: { marginBottom: space.xxl },
  card: { padding: space.margin, gap: space.sm, ...squircle },
  unfolded: { position: 'absolute', top: 0, left: 0, right: 0 },
  body: { ...typo.body, color: c.label },
  toggle: { ...typo.subheadline, fontWeight: weight.semibold, color: c.accentText },
  pending: { alignItems: 'center', paddingVertical: space.lg },
  inset: { marginHorizontal: space.margin },
  note: { ...typo.footnote, color: c.secondaryLabel, paddingHorizontal: space.margin + space.xs },
  closing: { textAlign: 'center', marginTop: space.md },
}));
