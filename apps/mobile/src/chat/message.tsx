/**
 * Conversation turns (content layer — solid system colors, never glass):
 *
 *  - `UserMessage` — a right-aligned bubble (`bubble` fill, squircle 20) with
 *    any quoted context above it and an image grid; the context menu (long
 *    press, native lifted preview) offers 复制 / 编辑后重发.
 *  - `AiMessage`   — full-width plain text (no bubble), iOS reading typography:
 *    a thinking Sprouty until the first token, one compact disclosure row for
 *    the tool pipeline (→ /peek/tools sheet), collapsible reasoning, the reply
 *    markdown (unfolding block by block while streaming), a references row
 *    (→ /peek/refs sheet), a quiet metrics caption (or "已停止生成" for a
 *    reply the user stopped), and inline errors with 重试. Context menu
 *    (src/chat/message-menu.tsx — bounded excerpt preview, not the whole
 *    reply): 复制 / 分享 / 引用 / 重新生成 (latest reply only).
 *
 * Both are memoised on the message object — during streaming only the turn
 * being patched re-renders. Menu ids come back through `onAction(msg, id)`.
 */

import React, { memo, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { uploadUrl } from '../api/upload';
import { compactNumber } from '../lib/format';
import { translate, useT } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import { makeStyles, radius, space, squircle, typo, useTheme } from '../theme';
import { NativeButton } from '../ui/button';
import { Icon, type IconName, Spinner } from '../ui/core';
import { NativeMenu, menuSections, type MenuItem } from '../ui/menu';
import { SproutyFace } from '../ui/sprouty';
import { Markdown } from './markdown';
import { MessageMenu } from './message-menu';
import type { ChatMessage, Metrics, ToolStep } from './model';

export type MessageAction = 'copy' | 'share' | 'quote' | 'regenerate' | 'edit';

/* ----------------------------- shared row ----------------------------- */

/** A quiet tappable line (icon · label · chevron) for tools / references / reasoning. */
function DisclosureRow({
  icon,
  label,
  onPress,
  open,
  accessibilityHint,
}: {
  icon: IconName;
  label: string;
  onPress?: () => void;
  /** Set for in-place toggles (chevron rotates); omit for rows that open a sheet. */
  open?: boolean;
  accessibilityHint?: string;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={open === undefined ? undefined : { expanded: open }}
      style={({ pressed }) => [styles.disclosure, pressed && { opacity: 0.5 }]}
    >
      <Icon name={icon} size={14} weight="medium" color={c.secondaryLabel} />
      <Text style={styles.disclosureText}>{label}</Text>
      <Icon
        name={open === undefined ? 'chevR' : open ? 'chevD' : 'chevR'}
        size={11}
        weight="semibold"
        color={c.tertiaryLabel}
      />
    </Pressable>
  );
}

/* ----------------------------- assistant ----------------------------- */

function Thinking() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.45, { duration: 900 }), -1, true);
  }, [pulse]);
  const fade = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <View style={styles.thinking} accessible accessibilityLabel={t('chat.thinking')}>
      <SproutyFace expr="thinking" size={34} />
      <Animated.Text style={[styles.thinkingText, fade]}>{t('chat.thinking')}</Animated.Text>
    </View>
  );
}

function ToolsRow({ steps, live, onOpen }: { steps: ToolStep[]; live: boolean; onOpen: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const done = steps.filter((s) => s.status !== 'running').length;
  // Watch the calls execute while the turn streams; collapse to one row after.
  if (live && done < steps.length) {
    return (
      <View style={styles.disclosure}>
        <Spinner />
        <Text style={styles.disclosureText}>{t('chat.toolsRunning', { done, total: steps.length })}</Text>
      </View>
    );
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

function Reasoning({ text }: { text: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <View>
      <DisclosureRow icon="brain" label={t('chat.reasoning')} open={open} onPress={() => setOpen((o) => !o)} />
      {open ? (
        <Animated.View entering={FadeIn.duration(180)} style={styles.reasonBody}>
          <View style={styles.reasonBar} />
          <Text style={styles.reasonText}>{text}</Text>
        </Animated.View>
      ) : null}
    </View>
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
  onOpenTools,
  onOpenRefs,
  onAction,
  onRetry,
}: {
  msg: ChatMessage;
  /** The newest reply — the only one that can be regenerated / retried. */
  isLatest: boolean;
  readOnly: boolean;
  onOpenTools: (msg: ChatMessage) => void;
  onOpenRefs: (msg: ChatMessage) => void;
  onAction: (msg: ChatMessage, action: MessageAction) => void;
  onRetry: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const live = msg.status !== 'done';
  const refCount = (msg.sources?.length ?? 0) + (msg.web?.length ?? 0);
  const canRerun = isLatest && !live && !readOnly;

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
    <View style={styles.aiRow}>
      {msg.status === 'thinking' ? <Thinking /> : null}
      {msg.tools?.length && msg.status !== 'thinking' ? (
        <ToolsRow steps={msg.tools} live={live} onOpen={() => onOpenTools(msg)} />
      ) : null}
      {msg.reasoning && !live ? <Reasoning text={msg.reasoning} /> : null}
      {msg.status !== 'thinking' && msg.text ? <Markdown source={msg.text} animated={live} /> : null}
      {msg.error ? <ErrorLine error={msg.error} onRetry={canRerun ? onRetry : undefined} /> : null}
      {!live && refCount ? (
        <DisclosureRow icon="book" label={t('chat.referencesCount', { n: refCount })} onPress={() => onOpenRefs(msg)} />
      ) : null}
      {!live && msg.stopped && !msg.error ? (
        <Text style={styles.metrics}>{t('chat.stopped')}</Text>
      ) : !live && msg.metrics && !msg.error ? (
        <MetricsCaption m={msg.metrics} />
      ) : null}
    </View>
  );

  return (
    <Animated.View entering={msg.fresh ? FadeIn.duration(220) : undefined}>
      {/* nothing to act on until text arrives */}
      {msg.text ? (
        <MessageMenu items={items} text={msg.text} onSelect={(id) => onAction(msg, id as MessageAction)}>
          {body}
        </MessageMenu>
      ) : (
        body
      )}
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
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const items = useMemo<MenuItem[]>(
    () => [
      ...(msg.text ? [{ id: 'copy', title: translate(lang, 'chat.actionCopy'), icon: 'copy' as const }] : []),
      ...(readOnly || !msg.text
        ? []
        : [{ id: 'edit', title: translate(lang, 'chat.actionEditResend'), icon: 'pen' as const }]),
    ],
    [lang, readOnly, msg.text],
  );
  const images = msg.images ?? [];

  const content = (
    <View style={styles.userCol}>
      {images.length ? (
        <View style={styles.userImages}>
          {images.map((im, i) =>
            im.url ? (
              <Image
                key={im.id || i}
                source={{ uri: uploadUrl(im.url) }}
                style={[styles.userThumb, images.length === 1 && styles.userThumbSingle]}
                contentFit="cover"
                transition={150}
                accessibilityLabel={t('chat.image')}
              />
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
      {msg.text ? (
        <View style={styles.bubble}>
          <Text style={styles.userText}>{msg.text}</Text>
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
  aiRow: { paddingHorizontal: space.margin, paddingTop: space.xs, paddingBottom: space.lg, gap: space.xs },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  thinkingText: { ...typo.subheadline, color: c.secondaryLabel },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.xs + 2,
    minHeight: 30,
  },
  disclosureText: { ...typo.subheadline, color: c.secondaryLabel },
  reasonBody: { flexDirection: 'row', gap: space.md, marginTop: space.xs, marginBottom: space.sm },
  reasonBar: { width: 2, borderRadius: 1, backgroundColor: c.separator },
  reasonText: { flex: 1, ...typo.subheadline, lineHeight: 21, color: c.secondaryLabel },
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
  bubble: {
    backgroundColor: c.bubble,
    borderRadius: radius.bubble,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md + 2,
    ...squircle,
  },
  userText: { ...typo.body, color: c.label },
}));
