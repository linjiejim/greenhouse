import { TodoPlan } from './todo-plan';
import { readAloud, useSpeech } from '../voice/read-aloud';
/**
 * Messages of a conversation (content layer — solid system colors, never glass), in the order
 * docs/design-system/conversation.md sets for a reply: conclusion → result cards → decisions →
 * sources → process.
 *
 *  - `MemberMessage` — a person's words. Mine sit on the right in a light bubble; another
 *    person's (a room) on the left under their face and name, shown on the first of a run.
 *    Above the bubble: the quoted piece and the skill run with `/`; below: the files (pictures
 *    inline, the rest as chips that open), the time, "edited", and in a room who has read it.
 *    Long press: copy, and on my last message edit.
 *  - `AgentReply` — an Agent's reply, without a bubble: its author line (plant, name, time) on
 *    the first of a run; while it is being written the text grows from ../data/streams.ts and
 *    the plant thinks until the first words; rich blocks (../chat/markdown); its files; the
 *    「需要你」 cards of its run; a row of sources; the process (all its tool steps) folded into
 *    one line that opens them; "stopped" or "failed" notes. Long press: copy, share, quote,
 *    👍 / 👎, new chat from here, and on my latest exchange regenerate.
 *  - `EventLine` — a quiet centred line (a hand-off, someone joining).
 *
 * Rows are memoised on their message: while a reply streams only its own row re-renders (it
 * subscribes to its stream). Menu picks come back through `onAction(message, action)`.
 */

import React, { memo, useEffect, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import Animated, {
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { fileUrl } from '../api/files';
import { liveText } from '../data/streams';
import { useStream } from '../data/use-stream';
import { formatBytes } from '../lib/format';
import { translate, useT } from '../lib/i18n';
import { openLink } from '../lib/links';
import type { MessageItem } from '../shared/contract';
import { isImage, useFiles } from '../store/files';
import { usePrefs } from '../store/prefs';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { AgentAvatar, MemberAvatar, type AgentFace } from '../ui/agent-avatar';
import { NativeButton } from '../ui/button';
import { showErrorDetails } from '../ui/dialogs';
import { Icon, type IconName, Spinner, Touchable } from '../ui/core';
import { useFontScaleKey } from '../ui/font-scale';
import { NativeMenu, menuSections, type MenuItem } from '../ui/menu';
import { fileIcon, saveFile } from './file-card';
import { Markdown, RichContext, type RichEnv } from './markdown';
import { Inline } from './markdown/inline';

export type MessageAction = 'copy' | 'share' | 'quote' | 'edit' | 'regenerate' | 'rateUp' | 'rateDown' | 'newChat';

/** A tool step as a reply shows it: settled ones from the message, live ones from the stream. */
export interface StepView {
  id: string;
  tool: string;
  summary: string;
  status: 'running' | 'done' | 'failed';
  duration_ms?: number;
}

/** The text and steps a reply shows right now (its stream while it is being written). */
export function useReplyContent(message: MessageItem): { text: string; steps: StepView[]; live: boolean } {
  const live = message.status === 'streaming';
  const stream = useStream(message.id);
  return useMemo(() => {
    if (!live) {
      return {
        text: message.content,
        steps: message.steps.map((step, index) => ({ id: `s${index}`, ...step })),
        live,
      };
    }
    return { text: liveText(message.content, stream), steps: stream?.steps ?? [], live };
  }, [live, message.content, message.steps, stream]);
}

/* ----------------------------- shared rows ----------------------------- */

/** A quiet tappable line (icon · label · chevron) that opens a sheet: the process, the reasoning. */
export function DisclosureRow({
  icon,
  busy,
  label,
  detail,
  tone,
  onPress,
}: {
  icon: IconName;
  /** A spinner instead of the icon (a step is still running). */
  busy?: boolean;
  label: string;
  /** A faint trailing line. */
  detail?: string;
  tone?: 'danger';
  onPress?: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const color = tone === 'danger' ? c.red : c.secondaryLabel;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      style={({ pressed }) => [styles.disclosure, pressed && { opacity: 0.5 }]}
    >
      {busy ? (
        <Spinner style={styles.disclosureSpinner} />
      ) : (
        <Icon name={icon} size={14} weight="medium" color={color} />
      )}
      <Text numberOfLines={1} style={[styles.disclosureText, { color }]}>
        {label}
      </Text>
      {detail ? (
        <Text numberOfLines={1} style={styles.disclosureDetail}>
          {detail}
        </Text>
      ) : null}
      <Icon name="chevR" size={11} weight="semibold" color={c.tertiaryLabel} />
    </Pressable>
  );
}

/** The plant thinking until the first words arrive. */
function Thinking() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.45, { duration: 900, reduceMotion: ReduceMotion.System }), -1, true);
  }, [pulse]);
  const fade = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <View style={styles.thinking} accessible accessibilityLabel={t('conversation.thinking')}>
      <Animated.Text style={[styles.thinkingText, fade]}>{t('conversation.thinking')}</Animated.Text>
    </View>
  );
}

export function ReplyError({ detail, onRetry }: { detail?: string; onRetry?: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <View style={styles.error}>
      <Icon name="alert" size={15} weight="semibold" color={c.red} />
      <Text style={styles.errorText}>{t('conversation.replyFailed')}</Text>
      {detail ? (
        <NativeButton label={t('common.details')} size="small" onPress={() => showErrorDetails(detail)} />
      ) : null}
      {onRetry ? <NativeButton label={t('common.retry')} icon="refresh" size="small" onPress={onRetry} /> : null}
    </View>
  );
}

/* ----------------------------- files ----------------------------- */

/** A message's files: pictures inline (tap: full size), the rest as chips that open. */
export const MessageFiles = memo(function MessageFiles({ ids, align }: { ids: string[]; align: 'start' | 'end' }) {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { files, loading } = useFiles(ids);
  if (!ids.length) return null;
  const images = files.filter(isImage);
  const others = files.filter((file) => !isImage(file));
  const justify = align === 'end' ? 'flex-end' : 'flex-start';
  return (
    <View style={[styles.files, { justifyContent: justify }]}>
      {images.map((file) => (
        <Touchable
          key={file.id}
          onPress={() => void openLink(fileUrl(file.url), hex.accent).catch(() => {})}
          accessibilityRole="imagebutton"
          accessibilityLabel={file.name || t('conversation.image')}
        >
          <Image
            source={{ uri: fileUrl(file.url) }}
            style={[styles.thumb, images.length === 1 && styles.thumbSingle]}
            contentFit="cover"
            transition={150}
          />
        </Touchable>
      ))}
      {others.map((file) => (
        <Touchable
          key={file.id}
          onPress={() => saveFile(fileUrl(file.url), file.name)}
          style={styles.chip}
          accessibilityRole="button"
          accessibilityLabel={t('conversation.openFile', { name: file.name })}
        >
          <Icon name={fileIcon(file.name)} size={13} color={c.secondaryLabel} />
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.chipName}>
            {file.name}
          </Text>
          <Text style={styles.chipSize}>{formatBytes(file.size_bytes)}</Text>
        </Touchable>
      ))}
      {loading && !files.length ? <View style={[styles.chip, styles.chipLoading]} /> : null}
    </View>
  );
});

/* ----------------------------- a person ----------------------------- */

export const MemberMessage = memo(function MemberMessage({
  message,
  mine,
  author,
  showAuthor,
  time,
  readBy,
  editable,
  skillName,
  onAction,
}: {
  message: MessageItem;
  mine: boolean;
  /** Who wrote it (another person: their face and name lead the first of their messages). */
  author: { name: string; avatarUrl: string | null };
  showAuthor: boolean;
  /** Its time as people read it (content.md). */
  time: string;
  /** A room, my message: who has read it. */
  readBy?: string[];
  /** My last message, while nobody has answered past it: it can be edited. */
  editable: boolean;
  /** The skill it ran with `/`, by name. */
  skillName?: string;
  onAction: (message: MessageItem, action: MessageAction) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const fontKey = useFontScaleKey();
  const text = message.content;
  const items = useMemo<MenuItem[]>(
    () => [
      ...(text ? [{ id: 'copy', title: translate(lang, 'conversation.copy'), icon: 'copy' as const }] : []),
      ...(text ? [{ id: 'quote', title: translate(lang, 'conversation.quote'), icon: 'quote' as const }] : []),
      ...(editable ? [{ id: 'edit', title: translate(lang, 'conversation.edit'), icon: 'pen' as const }] : []),
    ],
    [lang, text, editable],
  );
  const variables = message.skill ? Object.values(message.skill.variables).filter(Boolean) : [];
  const meta = [
    time,
    message.edited_at ? t('conversation.edited') : '',
    message.event?.type === 'interjection'
      ? t(
          message.event.state === 'incorporated'
            ? 'integration.incorporated'
            : message.event.state === 'canceled'
              ? 'integration.interjectionStopped'
              : 'conversation.queued',
        )
      : '',
    readBy?.length ? t('conversation.readBy', { n: readBy.length }) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const content = (
    <View style={[styles.memberCol, !mine && styles.theirCol]}>
      {message.quote ? (
        <View style={styles.quote}>
          <View style={styles.quoteBar} />
          <Text numberOfLines={3} style={styles.quoteText}>
            {message.quote.text}
          </Text>
        </View>
      ) : null}
      {message.skill ? (
        <View style={styles.skillTag}>
          <Icon name="wand" size={12} color={c.accent} />
          <Text numberOfLines={1} style={styles.skillText}>
            {skillName ? `/${skillName}` : t('conversation.skill')}
            {variables.length ? ` · ${variables.join(' · ')}` : ''}
          </Text>
        </View>
      ) : null}
      {text ? (
        <View style={[styles.bubble, !mine && styles.theirBubble]}>
          <Text style={styles.bubbleText}>
            <Inline text={text} />
          </Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <Animated.View key={fontKey} style={[styles.memberRow, !mine && styles.theirRow]}>
      {!mine && showAuthor ? (
        <View style={styles.authorLine} accessibilityRole="header">
          <MemberAvatar name={author.name} url={author.avatarUrl} size={22} />
          <Text style={styles.authorName} numberOfLines={1}>
            {author.name}
          </Text>
        </View>
      ) : null}
      {items.length ? (
        <NativeMenu
          // the menu pins the width it measured first: an edit (new words) measures again
          key={message.edited_at ?? 'original'}
          trigger="longPress"
          items={items}
          onSelect={(id) => onAction(message, id as MessageAction)}
          style={[styles.memberMenu, !mine && styles.theirMenu]}
        >
          {content}
        </NativeMenu>
      ) : (
        content
      )}
      {message.reactions?.length ? <View style={{ flexDirection: 'row', gap: 4 }}>{message.reactions.map(reaction=><Text key={reaction.agent_id} accessibilityLabel={reaction.emoji} style={styles.sourceChip}>{reaction.emoji}</Text>)}</View> : null}
      <MessageFiles ids={message.attachments} align={mine ? 'end' : 'start'} />
      {meta ? (
        <Text
          style={[styles.meta, mine ? styles.metaMine : null]}
          accessibilityLabel={
            readBy?.length ? t('conversation.readByNames', { names: readBy.join(t('common.listSep')) }) : undefined
          }
        >
          {meta}
        </Text>
      ) : null}
    </Animated.View>
  );
});

/* ----------------------------- an Agent ----------------------------- */

export const AgentReply = memo(function AgentReply({
  message,
  author,
  showAuthor,
  time,
  canRegenerate,
  readOnly,
  followUp,
  cards,
  onAction,
  onReply,
  onOpenSteps,
  onOpenSources,
}: {
  message: MessageItem;
  author: { name: string; agent: AgentFace | null };
  showAuthor: boolean;
  time: string;
  /** The settled reply of my latest exchange: it can be written again. */
  canRegenerate: boolean;
  readOnly: boolean;
  /** My message that followed this reply (a ```confirm shows which choice was sent). */
  followUp?: string;
  /** The 「需要你」 cards of its run (already rendered — the screen owns them). */
  cards?: React.ReactNode;
  onAction: (message: MessageItem, action: MessageAction) => void;
  /** Send a follow-up from a block in the reply (a ```confirm pick); false when it did not go. */
  onReply: (text: string) => Promise<boolean>;
  onOpenSteps: (message: MessageItem) => void;
  onOpenSources: (message: MessageItem) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const fontKey = useFontScaleKey();
  const { text, steps, live } = useReplyContent(message);
  const rich = useMemo<RichEnv>(
    () => ({ reply: readOnly ? undefined : onReply, followUp }),
    [readOnly, onReply, followUp],
  );
  const reading = useSpeech((s) => s.id === message.id);
  const rating = message.my_rating;
  const thinking = live && !text && !steps.length;
  const failedSteps = steps.filter((step) => step.status === 'failed').length;
  const runningSteps = steps.filter((step) => step.status === 'running').length;

  const items = useMemo<MenuItem[]>(
    () =>
      menuSections([
        [
          { id: 'copy', title: translate(lang, 'conversation.copy'), icon: 'copy' },
          { id: 'share', title: translate(lang, 'conversation.share'), icon: 'share' },
          {
            id: 'readAloud',
            title: translate(lang, reading ? 'work.stopReading' : 'work.readAloud'),
            icon: reading ? 'stop' : 'speaker',
          },
          ...(readOnly ? [] : [{ id: 'quote', title: translate(lang, 'conversation.quote'), icon: 'quote' as const }]),
        ],
        [
          {
            id: 'rateUp',
            title: translate(lang, 'conversation.helpful'),
            icon: rating === 1 ? ('thumbUpFill' as const) : ('thumbUp' as const),
          },
          {
            id: 'rateDown',
            title: translate(lang, 'conversation.notHelpful'),
            icon: rating === -1 ? ('thumbDownFill' as const) : ('thumbDown' as const),
          },
        ],
        [
          { id: 'newChat', title: translate(lang, 'conversation.newChatFromHere'), icon: 'branch' },
          ...(canRegenerate && !readOnly
            ? [{ id: 'regenerate', title: translate(lang, 'conversation.regenerate'), icon: 'refresh' as const }]
            : []),
        ],
      ]),
    [lang, readOnly, canRegenerate, rating, reading],
  );

  const body = (
    <View style={styles.replyBody}>
      {thinking ? <Thinking /> : null}
      {text ? (
        <RichContext.Provider value={rich}>
          <Markdown source={text} calm animated={live} safe={message.event?.type === 'run_report'} />
        </RichContext.Provider>
      ) : null}
    </View>
  );

  const sources = !live && message.citations.length ? message.citations : null;
  return (
    <Animated.View
      key={fontKey}
      entering={live ? FadeIn.duration(200).reduceMotion(ReduceMotion.System) : undefined}
      style={styles.replyRow}
    >
      {showAuthor ? (
        <View style={styles.replyAuthor} accessibilityRole="header">
          <AgentAvatar agent={author.agent} size={22} state={live ? 'thinking' : undefined} />
          <Text style={styles.authorName} numberOfLines={1}>
            {author.name}
          </Text>
          {time ? <Text style={styles.authorTime}>{time}</Text> : null}
        </View>
      ) : null}
      {body}
      <View style={styles.replyTail}>
        <TodoPlan blocks={message.blocks} />
        {text && !live ? (
          <NativeMenu
            items={items}
            onSelect={(id) =>
              id === 'readAloud' ? void readAloud(message.id, text) : onAction(message, id as MessageAction)
            }
            width={44}
          >
            <View style={styles.more} accessible accessibilityRole="button" accessibilityLabel={t('common.more')}>
              <Icon name="more" size={20} color={c.secondaryLabel} />
            </View>
          </NativeMenu>
        ) : null}
        <MessageFiles ids={message.attachments} align="start" />
        {cards}
        {sources ? (
          <Pressable
            onPress={() => onOpenSources(message)}
            accessibilityRole="button"
            accessibilityLabel={t('conversation.sourcesCount', { n: sources.length })}
            style={({ pressed }) => [styles.sources, pressed && { opacity: 0.5 }]}
          >
            <Text style={styles.sourcesLabel}>{t('conversation.sources')}</Text>
            {sources.slice(0, 3).map((source) => (
              <View key={`${source.kind}:${source.id}`} style={styles.sourceChip}>
                <Icon name={source.kind === 'doc' ? 'book' : 'globe'} size={11} color={c.secondaryLabel} />
                <Text numberOfLines={1} style={styles.sourceText}>
                  {sourceLabel(source)}
                </Text>
              </View>
            ))}
            {sources.length > 3 ? <Text style={styles.sourcesMore}>+{sources.length - 3}</Text> : null}
          </Pressable>
        ) : null}
        {steps.length ? (
          <DisclosureRow
            icon={failedSteps ? 'alert' : 'wrench'}
            busy={live && runningSteps > 0}
            tone={failedSteps ? 'danger' : undefined}
            label={stepsLabel(t, steps)}
            onPress={() => onOpenSteps(message)}
          />
        ) : null}
        {message.status === 'failed' ? <ReplyError /> : null}
        {message.status === 'stopped' ? <Text style={styles.note}>{t('conversation.stopped')}</Text> : null}
        {rating ? (
          <View
            style={styles.rated}
            accessible
            accessibilityLabel={t(rating === 1 ? 'conversation.ratedUp' : 'conversation.ratedDown')}
          >
            <Icon name={rating === 1 ? 'thumbUpFill' : 'thumbDownFill'} size={13} color={c.tertiaryLabel} />
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
});

/** One line for a reply's process: the step that ran, or the first of several and their count. */
function stepsLabel(t: ReturnType<typeof useT>, steps: readonly StepView[]): string {
  const first = steps[0]!.summary || steps[0]!.tool;
  return steps.length === 1 ? first : t('conversation.stepsMore', { first, n: steps.length });
}

/** A source as its label: a web page by its host, anything else by its title. */
export function sourceLabel(source: { title: string; url?: string }): string {
  if (source.url && /^https?:\/\//i.test(source.url)) {
    try {
      return new URL(source.url).host.replace(/^www\./, '');
    } catch {
      return source.title;
    }
  }
  return source.title;
}

/* ----------------------------- an event ----------------------------- */

export const EventLine = memo(function EventLine({ text }: { text: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  if (!text.trim()) return null;
  return (
    <View style={styles.event} accessibilityRole="text">
      <Text style={styles.eventText}>
        <Inline text={text} />
      </Text>
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  /* an Agent */
  replyRow: { paddingTop: space.xs, paddingBottom: space.lg, gap: space.xs },
  replyAuthor: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.margin,
    paddingTop: space.sm,
  },
  replyBody: { paddingHorizontal: space.margin, gap: space.xs },
  more: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  replyTail: { paddingHorizontal: space.margin, gap: space.sm, alignItems: 'flex-start' },
  authorName: { flexShrink: 1, ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  authorTime: { ...typo.caption1, color: c.tertiaryLabel },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  thinkingText: { ...typo.subheadline, color: c.secondaryLabel },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, minHeight: 30, maxWidth: '100%' },
  disclosureSpinner: { transform: [{ scale: 0.8 }] },
  disclosureText: { flexShrink: 1, ...typo.subheadline },
  disclosureDetail: { flexShrink: 1, ...typo.footnote, color: c.tertiaryLabel },
  sources: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.xs + 2, minHeight: 30 },
  sourcesLabel: { ...typo.footnote, color: c.secondaryLabel },
  sourceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: 180,
    paddingVertical: 3,
    paddingHorizontal: space.sm,
    borderRadius: radius.full,
    backgroundColor: c.tertiaryFill,
  },
  sourceText: { flexShrink: 1, ...typo.caption1, color: c.label },
  sourcesMore: { ...typo.caption1, color: c.secondaryLabel },
  note: { ...typo.footnote, color: c.tertiaryLabel },
  rated: { paddingVertical: 2 },
  error: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'stretch',
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: c.redFill,
    ...squircle,
  },
  errorText: { flex: 1, ...typo.footnote, color: c.red },

  /* files */
  files: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs + 2, alignSelf: 'stretch' },
  thumb: { width: 96, height: 96, borderRadius: radius.lg, backgroundColor: c.tertiaryFill, ...squircle },
  thumbSingle: { width: 200, height: 200 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 1,
    maxWidth: '100%',
    minHeight: 32,
    paddingVertical: space.xs + 1,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.full,
    backgroundColor: c.tertiaryFill,
  },
  chipLoading: { width: 120 },
  chipName: { ...typo.footnote, color: c.label, flexShrink: 1 },
  chipSize: { ...typo.caption1, color: c.secondaryLabel },

  /* a person */
  memberRow: {
    paddingHorizontal: space.margin,
    paddingTop: space.xs,
    paddingBottom: space.md,
    alignItems: 'flex-end',
    gap: space.xs,
  },
  memberMenu: { alignSelf: 'flex-end', maxWidth: '84%' },
  memberCol: { alignItems: 'flex-end', gap: space.xs + 2 },
  quote: { flexDirection: 'row', gap: space.sm, maxWidth: '100%', paddingRight: space.xs },
  quoteBar: { width: 3, borderRadius: 1.5, backgroundColor: c.accent },
  quoteText: { flexShrink: 1, ...typo.footnote, color: c.secondaryLabel },
  skillTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    maxWidth: '100%',
    paddingVertical: 3,
    paddingHorizontal: space.sm,
    borderRadius: radius.full,
    backgroundColor: c.accentFill,
  },
  skillText: { flexShrink: 1, ...typo.footnote, color: c.accent },
  bubble: {
    backgroundColor: c.bubble,
    borderRadius: radius.bubble,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md + 2,
    ...squircle,
  },
  bubbleText: { ...typo.body, color: c.label },
  meta: { ...typo.caption1, color: c.tertiaryLabel },
  metaMine: { textAlign: 'right' },
  theirRow: { alignItems: 'flex-start' },
  theirMenu: { alignSelf: 'flex-start' },
  theirCol: { alignItems: 'flex-start' },
  theirBubble: { backgroundColor: c.tertiaryFill },
  authorLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: space.sm },

  /* an event */
  event: { paddingHorizontal: space.xxl, paddingVertical: space.sm, alignItems: 'center' },
  eventText: { ...typo.footnote, color: c.secondaryLabel, textAlign: 'center' },
}));
