/**
 * Conversation turns (content layer — solid system colors, never glass):
 *
 *  - `UserMessage` — a right-aligned bubble (`bubble` fill, squircle 20) with
 *    any quoted context above it, its text with inline marks (bold, links,
 *    code — web parity), an image grid (tap → full size) and the
 *    files attached to the turn as chips (the server's ```attachments fence,
 *    lifted out of the text); the context menu (long press, native lifted
 *    preview) offers 复制 / 编辑后重发.
 *  - `AiMessage`   — full-width plain text (no bubble), iOS reading typography:
 *    a thinking Sprouty until the first token (showing the reasoning's latest
 *    headline once there is one), a reasoning row (→ /peek/reasoning sheet)
 *    and one compact row for the tool pipeline (→ /peek/tools sheet) — both
 *    tappable while the turn runs, their sheets follow it live
 *    (src/chat/live-turn.ts) — tool results that are cards (files, generated
 *    images, sub-sessions; src/chat/artifacts.tsx), the reply markdown
 *    (unfolding block by block while streaming; its ```confirm buttons reply
 *    through `onReply`), the ask_user form below it once the turn is done, a
 *    references row (→ /peek/refs sheet), a quiet metrics caption (or
 *    "已停止生成" for a reply the user stopped), and inline errors with 重试.
 *    Context menu (src/chat/message-menu.tsx — bounded excerpt preview, not
 *    the whole reply): 复制 / 分享 / 引用 / 重新生成 (latest reply only).
 *
 * Both are memoised on the message object — during streaming only the turn
 * being patched re-renders. Menu ids come back through `onAction(msg, id)`.
 */

import React, { memo, useEffect, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { uploadUrl } from '../api/upload';
import { compactNumber } from '../lib/format';
import { translate, useT } from '../lib/i18n';
import { openLink } from '../lib/links';
import { splitAttachments } from '../shared/rich-output';
import { usePrefs } from '../store/prefs';
import { makeStyles, radius, space, squircle, typo, useTheme } from '../theme';
import { NativeButton } from '../ui/button';
import { Icon, type IconName, Spinner, Touchable } from '../ui/core';
import { NativeMenu, menuSections, type MenuItem } from '../ui/menu';
import { SproutyFace } from '../ui/sprouty';
import { ArtifactCards, isBelowProse, replacesRow } from './artifacts';
import { AttachmentChip } from './file-card';
import { Markdown, RichContext, type RichEnv } from './markdown';
import { Inline } from './markdown/inline';
import { MessageMenu } from './message-menu';
import type { ChatMessage, Metrics, ToolStep } from './model';

export type MessageAction = 'copy' | 'share' | 'quote' | 'regenerate' | 'edit';

/* ----------------------------- shared row ----------------------------- */

/** A quiet tappable line (icon · label · chevron) for tools / references / reasoning — each opens a sheet. */
function DisclosureRow({
  icon,
  busy,
  label,
  detail,
  onPress,
  accessibilityHint,
}: {
  icon: IconName;
  /** A spinner instead of the icon (the step is still running). */
  busy?: boolean;
  label: string;
  /** A faint trailing line (the reasoning's latest headline). */
  detail?: string;
  onPress?: () => void;
  accessibilityHint?: string;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [styles.disclosure, detail ? styles.disclosureWide : null, pressed && { opacity: 0.5 }]}
    >
      {busy ? <Spinner style={styles.disclosureSpinner} /> : <Icon name={icon} size={14} weight="medium" color={c.secondaryLabel} />}
      <Text style={styles.disclosureText}>{label}</Text>
      <Icon name="chevR" size={11} weight="semibold" color={c.tertiaryLabel} />
      {detail ? (
        <Text numberOfLines={1} style={styles.disclosureDetail}>
          {detail}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * The first line of the most recently *completed* reasoning paragraph — the
 * one still streaming would flicker on every token (web: reasoningHeadline).
 */
function reasoningHeadline(reasoning: string): string {
  const firsts = reasoning
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').find((l) => l.trim())?.trim() ?? '')
    .filter(Boolean);
  return (firsts.at(-2) ?? '').replace(/[*_#`]/g, '').trim().slice(0, 160);
}

/* ----------------------------- assistant ----------------------------- */

/** The thinking Sprouty; with reasoning streaming in, it shows the latest headline and opens the live sheet. */
function Thinking({ headline, onOpen }: { headline?: string; onOpen?: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.45, { duration: 900 }), -1, true);
  }, [pulse]);
  const fade = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <Pressable
      onPress={onOpen}
      disabled={!onOpen}
      accessibilityRole={onOpen ? 'button' : undefined}
      accessibilityLabel={headline ? `${t('chat.thinking')}, ${headline}` : t('chat.thinking')}
      style={({ pressed }) => [styles.thinking, pressed && { opacity: 0.6 }]}
    >
      <SproutyFace expr="thinking" size={34} />
      <View style={styles.thinkingTexts}>
        <View style={styles.thinkingLine}>
          <Animated.Text style={[styles.thinkingText, fade]}>{t('chat.thinking')}</Animated.Text>
          {onOpen ? <Icon name="chevR" size={11} weight="semibold" color={c.tertiaryLabel} /> : null}
        </View>
        {headline ? (
          <Animated.Text key={headline} entering={FadeIn.duration(200)} numberOfLines={1} style={styles.thinkingHeadline}>
            {headline}
          </Animated.Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function ToolsRow({ steps, live, onOpen }: { steps: ToolStep[]; live: boolean; onOpen: () => void }) {
  const t = useT();
  const done = steps.filter((s) => s.status !== 'running').length;
  // While the turn streams the row counts the calls as they run (its sheet follows them live).
  if (live && done < steps.length) {
    return <DisclosureRow icon="wrench" busy label={t('chat.toolsRunning', { done, total: steps.length })} onPress={onOpen} />;
  }
  const failed = steps.some((s) => s.status === 'error');
  return (
    <DisclosureRow
      icon={failed ? 'alert' : 'wrench'}
      label={steps.length === 1 ? t('chat.toolUsed') : t('chat.toolsUsed', { n: steps.length })}
      onPress={onOpen}
    />
  );
}

/** Reasoning → its sheet (live while the model is still thinking: spinner + latest headline). */
function ReasoningRow({ text, active, onOpen }: { text: string; active: boolean; onOpen: () => void }) {
  const t = useT();
  return active ? (
    <DisclosureRow icon="brain" busy label={t('chat.thinking')} detail={reasoningHeadline(text) || undefined} onPress={onOpen} />
  ) : (
    <DisclosureRow icon="brain" label={t('chat.reasoning')} onPress={onOpen} />
  );
}

function MetricsCaption({ m }: { m: Metrics }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const parts: string[] = [];
  if (m.seconds != null) parts.push(t('chat.seconds', { s: m.seconds.toFixed(1) }));
  if (m.tokensIn != null && m.tokensOut != null) {
    parts.push(t('chat.metricsTokens', { in: compactNumber(m.tokensIn), out: compactNumber(m.tokensOut) }));
  }
  if (!parts.length) return null;
  return <Text style={styles.metrics}>{parts.join(' · ')}</Text>;
}

function ErrorLine({ error, onRetry }: { error: string; onRetry?: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <View style={styles.error}>
      <Icon name="alert" size={15} weight="semibold" color={c.red} />
      <Text style={styles.errorText} selectable>
        {error}
      </Text>
      {onRetry ? <NativeButton label={t('common.retry')} icon="refresh" size="small" onPress={onRetry} /> : null}
    </View>
  );
}

export const AiMessage = memo(function AiMessage({
  msg,
  isLatest,
  readOnly,
  followUp,
  onOpenTools,
  onOpenReasoning,
  onOpenRefs,
  onAction,
  onRetry,
  onReply,
}: {
  msg: ChatMessage;
  /** The newest reply — the only one that can be regenerated / retried. */
  isLatest: boolean;
  readOnly: boolean;
  /** The user message that followed this reply (answers an ask_user form / a ```confirm). */
  followUp?: string;
  onOpenTools: (msg: ChatMessage) => void;
  onOpenReasoning: (msg: ChatMessage) => void;
  onOpenRefs: (msg: ChatMessage) => void;
  onAction: (msg: ChatMessage, action: MessageAction) => void;
  onRetry: () => void;
  /** Send a follow-up message from a card in the reply (resolves false if it didn't go). */
  onReply: (text: string) => Promise<boolean>;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const live = msg.status !== 'done';
  const refCount = (msg.sources?.length ?? 0) + (msg.web?.length ?? 0);
  const canRerun = isLatest && !live && !readOnly;
  const reply = readOnly ? undefined : onReply;
  // tool calls: rows in the sheet vs. cards in the reply (src/chat/artifacts.tsx)
  const tools = msg.tools;
  const trace = useMemo(() => (tools ?? []).filter((s) => !replacesRow(s)), [tools]);
  const cardsAbove = useMemo(() => (tools ?? []).filter((s) => !isBelowProse(s)), [tools]);
  const cardsBelow = useMemo(() => (tools ?? []).filter(isBelowProse), [tools]);
  const rich = useMemo<RichEnv>(() => ({ reply, followUp }), [reply, followUp]);
  const thinking = msg.status === 'thinking';

  // Keyed on the language (not `t`, which is new every render) so a streaming
  // reply doesn't rebuild its native menu on every tick.
  const lang = usePrefs((s) => s.lang);
  const items = useMemo<MenuItem[]>(
    () =>
      menuSections([
        [
          { id: 'copy', title: translate(lang, 'chat.actionCopy'), icon: 'copy' },
          { id: 'share', title: translate(lang, 'chat.actionShare'), icon: 'share' },
          ...(readOnly ? [] : [{ id: 'quote', title: translate(lang, 'chat.actionQuote'), icon: 'quote' as const }]),
        ],
        canRerun ? [{ id: 'regenerate', title: translate(lang, 'chat.actionRegenerate'), icon: 'refresh' }] : [],
      ]),
    [lang, readOnly, canRerun],
  );

  const body = (
    <View style={styles.aiBody}>
      {thinking ? (
        <Thinking
          headline={msg.reasoning ? reasoningHeadline(msg.reasoning) || undefined : undefined}
          onOpen={msg.reasoning ? () => onOpenReasoning(msg) : undefined}
        />
      ) : null}
      {/* with the first text / tool, not at the end — appearing then would push the whole reply down */}
      {msg.reasoning && !thinking ? (
        <ReasoningRow text={msg.reasoning} active={live && !msg.text} onOpen={() => onOpenReasoning(msg)} />
      ) : null}
      {trace.length && !thinking ? <ToolsRow steps={trace} live={live} onOpen={() => onOpenTools(msg)} /> : null}
      {!thinking && cardsAbove.length ? <ArtifactCards steps={cardsAbove} text={msg.text} live={live} /> : null}
      {!thinking && msg.text ? (
        <RichContext.Provider value={rich}>
          <Markdown source={msg.text} animated={live} />
        </RichContext.Provider>
      ) : null}
    </View>
  );

  // Outside the long-press menu: the ask_user form has text fields (a long
  // press there places the caret, it mustn't lift the reply), and the rest is
  // status, not content.
  const tailItems = [
    cardsBelow.length && !live ? (
      <ArtifactCards key="cards" steps={cardsBelow} text={msg.text} live={live} followUp={followUp} onReply={reply} />
    ) : null,
    msg.error ? <ErrorLine key="error" error={msg.error} onRetry={canRerun ? onRetry : undefined} /> : null,
    !live && refCount ? (
      <DisclosureRow
        key="refs"
        icon="book"
        label={t('chat.referencesCount', { n: refCount })}
        onPress={() => onOpenRefs(msg)}
      />
    ) : null,
    !live && msg.stopped && !msg.error ? (
      <Text key="stopped" style={styles.metrics}>
        {t('chat.stopped')}
      </Text>
    ) : !live && msg.metrics && !msg.error ? (
      <MetricsCaption key="metrics" m={msg.metrics} />
    ) : null,
  ];
  const tail = tailItems.some(Boolean) ? <View style={styles.aiTail}>{tailItems}</View> : null;

  return (
    <Animated.View entering={msg.fresh ? FadeIn.duration(220) : undefined} style={styles.aiRow}>
      {/* nothing to act on until text arrives */}
      {msg.text ? (
        <MessageMenu items={items} text={msg.text} onSelect={(id) => onAction(msg, id as MessageAction)}>
          {body}
        </MessageMenu>
      ) : (
        body
      )}
      {tail}
    </Animated.View>
  );
});

/* ----------------------------- user ----------------------------- */

export const UserMessage = memo(function UserMessage({
  msg,
  readOnly,
  onAction,
}: {
  msg: ChatMessage;
  readOnly: boolean;
  onAction: (msg: ChatMessage, action: MessageAction) => void;
}) {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  // a turn's attached files ride in the text as a server-written fence
  const { text, attachments } = useMemo(() => splitAttachments(msg.text), [msg.text]);
  const items = useMemo<MenuItem[]>(
    () => [
      ...(text ? [{ id: 'copy', title: translate(lang, 'chat.actionCopy'), icon: 'copy' as const }] : []),
      ...(readOnly || !text ? [] : [{ id: 'edit', title: translate(lang, 'chat.actionEditResend'), icon: 'pen' as const }]),
    ],
    [lang, readOnly, text],
  );
  const images = msg.images ?? [];

  const content = (
    <View style={styles.userCol}>
      {images.length ? (
        <View style={styles.userImages}>
          {images.map((im, i) =>
            im.url ? (
              <Touchable
                key={im.id || i}
                onPress={() => void openLink(uploadUrl(im.url!), hex.accent).catch(() => {})}
                accessibilityRole="imagebutton"
                accessibilityLabel={t('chat.image')}
              >
                <Image
                  source={{ uri: uploadUrl(im.url) }}
                  style={[styles.userThumb, images.length === 1 && styles.userThumbSingle]}
                  contentFit="cover"
                  transition={150}
                />
              </Touchable>
            ) : (
              <View key={im.id || i} style={[styles.userThumb, styles.userThumbEmpty]}>
                <Icon name="image" size={22} color={c.tertiaryLabel} />
              </View>
            ),
          )}
        </View>
      ) : null}
      {msg.annotation ? (
        <View style={styles.userQuote}>
          <View style={styles.userQuoteBar} />
          <Text numberOfLines={3} style={styles.userQuoteText}>
            {msg.annotation}
          </Text>
        </View>
      ) : null}
      {text ? (
        <View style={styles.bubble}>
          {/* inline marks like the web's bubble (an ask_user answer's **labels**, links, `code`) */}
          <Text style={styles.userText}>
            <Inline text={text} />
          </Text>
        </View>
      ) : null}
      {attachments.length ? (
        <View style={styles.userFiles}>
          {attachments.map((f) => (
            <AttachmentChip
              key={f.id ?? f.key}
              name={f.name}
              size={f.size_bytes}
              path={
                f.id
                  ? `/api/chat-files/${encodeURIComponent(f.id)}/content`
                  : `/api/missions/attachments/download?key=${encodeURIComponent(f.key!)}`
              }
            />
          ))}
        </View>
      ) : null}
    </View>
  );

  return (
    <Animated.View entering={msg.fresh ? FadeIn.duration(200) : undefined} style={styles.userRow}>
      {items.length ? (
        <NativeMenu
          trigger="longPress"
          items={items}
          onSelect={(id) => onAction(msg, id as MessageAction)}
          style={styles.userMenu}
        >
          {content}
        </NativeMenu>
      ) : (
        content
      )}
    </Animated.View>
  );
});

const useStyles = makeStyles((c) => ({
  /* assistant */
  aiRow: { paddingTop: space.xs, paddingBottom: space.lg, gap: space.xs },
  aiBody: { paddingHorizontal: space.margin, gap: space.xs },
  aiTail: { paddingHorizontal: space.margin, gap: space.xs },
  thinking: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: space.sm, paddingVertical: space.xs },
  thinkingTexts: { flexShrink: 1 },
  thinkingLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  thinkingText: { ...typo.subheadline, color: c.secondaryLabel },
  thinkingHeadline: { ...typo.footnote, color: c.tertiaryLabel, marginTop: 1 },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.xs + 2,
    minHeight: 30,
  },
  // a row with a trailing detail spans the width (the detail truncates)
  disclosureWide: { alignSelf: 'stretch' },
  disclosureSpinner: { transform: [{ scale: 0.8 }] },
  disclosureText: { ...typo.subheadline, color: c.secondaryLabel },
  disclosureDetail: { flex: 1, ...typo.footnote, color: c.tertiaryLabel, marginLeft: space.xs },
  metrics: { ...typo.caption1, color: c.tertiaryLabel, marginTop: space.xs, fontVariant: ['tabular-nums'] },
  error: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xs,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: c.redFill,
    ...squircle,
  },
  errorText: { flex: 1, ...typo.footnote, color: c.red },

  /* user */
  userRow: { paddingHorizontal: space.margin, paddingTop: space.xs, paddingBottom: space.md, alignItems: 'flex-end' },
  userMenu: { alignSelf: 'flex-end', maxWidth: '84%' },
  userCol: { alignItems: 'flex-end', gap: space.xs + 2 },
  userImages: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space.xs + 2 },
  userThumb: { width: 96, height: 96, borderRadius: radius.lg, backgroundColor: c.tertiaryFill, ...squircle },
  userThumbSingle: { width: 200, height: 200 },
  userThumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  userQuote: { flexDirection: 'row', gap: space.sm, maxWidth: '100%', paddingRight: space.xs },
  userQuoteBar: { width: 3, borderRadius: 1.5, backgroundColor: c.accent },
  userQuoteText: { flexShrink: 1, ...typo.footnote, color: c.secondaryLabel },
  userFiles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space.xs + 2 },
  bubble: {
    backgroundColor: c.bubble,
    borderRadius: radius.bubble,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md + 2,
    ...squircle,
  },
  userText: { ...typo.body, color: c.label },
}));
