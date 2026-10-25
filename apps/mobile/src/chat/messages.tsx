/**
 * The rows of a conversation (content layer — solid colors, never glass):
 *
 *  - `UserMessage` — my words (inline Markdown, like the web's bubble) in a light bubble on the
 *    right, up to 80% of the width, my pictures and attached files under it (the ```attachments
 *    fence never shows as text). A quiet mark beside the bubble says where it is: a clock while it
 *    is on its way or waits for the station (queued offline, with a retry), a check once the
 *    station has it (my latest message only).
 *  - `AssistantReply` — the reply without a bubble: the sprout and "Sprouty" with, on the right of
 *    that row, what the reply is doing ("Searching knowledge…") or how many steps it took; tapping
 *    it opens the steps sheet. Tool steps never add or remove rows in the body, so the reply does
 *    not jump as they start and finish. Then the words with their rich blocks and link chips, the
 *    cards (questions, files, pictures, things to save or apply, extension cards) and the objects
 *    it cites or wrote. Sprouty's living face is in the page header (./header-avatar.tsx); the
 *    sprout here rests.
 *
 * Long press on either opens the message menu: Copy, Share, Quote Reply, and Regenerate on the
 * latest reply.
 */

import React, { memo, useMemo } from 'react';
import { Share, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useT } from '../lib/i18n';
import { Markdown, RichContext, type RichEnv } from '../markdown';
import { Inline } from '../markdown/inline';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { AssistantAvatar } from '../ui/avatar';
import { NativeButton } from '../ui/button';
import { Icon, Spinner, Touchable } from '../ui/core';
import { NativeMenu } from '../ui/menu';
import { selectionTick } from '../ui/haptics';
import { toast } from '../ui/toast';
import {
  AskUserCard,
  AttachmentRow,
  ExtensionCard,
  FileCard,
  GeneratedImage,
  MessageImages,
  ObjectCards,
  SchemaPlanCard,
  TaskCaptureCard,
} from './cards';
import { formatBytes } from '../lib/format';
import { useOpenObject } from '../shell/open-object';
import { citedObjects, replyCards, type AttachedFile, type ToolStep } from './parts';
import { humanize, toolActivity } from './tool-words';

/** A tool's name for people: `knowledge_query` → "Knowledge query" (run sheets). */
export const toolLabel = humanize;

/** What a long press on a message offers (Regenerate only on the latest reply, when idle). */
export interface MessageActions {
  onQuote?: (text: string) => void;
  onRegenerate?: () => void;
}

function MessageMenu({
  text,
  actions,
  style,
  children,
}: {
  text: string;
  actions?: MessageActions;
  style?: React.ComponentProps<typeof NativeMenu>['style'];
  children: React.ReactNode;
}) {
  const t = useT();
  const items = useMemo(
    () => [
      { id: 'copy', title: t('markdown.copy'), icon: 'copy' as const },
      { id: 'share', title: t('conversation.share'), icon: 'share' as const },
      ...(actions?.onQuote ? [{ id: 'quote', title: t('conversation.quote'), icon: 'quote' as const }] : []),
      ...(actions?.onRegenerate
        ? [{ id: 'regenerate', title: t('conversation.regenerate'), icon: 'refresh' as const }]
        : []),
    ],
    [t, actions?.onQuote, actions?.onRegenerate],
  );
  return (
    <NativeMenu
      trigger="longPress"
      style={style}
      items={items}
      onSelect={(id) => {
        selectionTick();
        if (id === 'copy') {
          void Clipboard.setStringAsync(text);
          toast(t('markdown.copied'), 'copy');
        } else if (id === 'share') void Share.share({ message: text });
        else if (id === 'quote') actions?.onQuote?.(text);
        else if (id === 'regenerate') actions?.onRegenerate?.();
      }}
    >
      {children}
    </NativeMenu>
  );
}

export const UserMessage = memo(function UserMessage({
  text,
  images,
  files,
  queued,
  failed,
  sending,
  delivered,
  actions,
  onRetry,
  onRemove,
}: {
  text: string;
  images: { id: string; url: string }[];
  files: AttachedFile[];
  /** Waiting for the station (sent offline). */
  queued?: boolean;
  /** Queued, and the station refused it: it waits for a retry or removal. */
  failed?: boolean;
  /** On its way: sent, not yet in the saved transcript. */
  sending?: boolean;
  /** My latest message, saved by the station. */
  delivered?: boolean;
  actions?: MessageActions;
  onRetry?: () => void;
  onRemove?: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const mark = failed ? null : queued || sending ? 'clock' : delivered ? 'check' : null;
  return (
    <View style={styles.userRow}>
      {text ? (
        <View style={styles.bubbleLine}>
          {mark ? (
            <View
              style={styles.mark}
              accessible
              accessibilityLabel={t(mark === 'check' ? 'conversation.delivered' : 'conversation.queued')}
            >
              <Icon name={mark} size={12} weight="semibold" color={c.tertiaryLabel} />
            </View>
          ) : null}
          <MessageMenu text={text} actions={actions} style={styles.bubbleSlot}>
            <View style={[styles.bubble, queued && styles.queued]}>
              {/* my words are Markdown, as on the web: an ask_user answer's **labels** read bold */}
              <Text style={styles.userText} selectable>
                <Inline text={text} />
              </Text>
            </View>
          </MessageMenu>
        </View>
      ) : null}
      <MessageImages images={images} align="end" />
      <AttachmentRow files={files} align="end" />
      {queued ? (
        <View style={styles.queuedLine}>
          {failed ? <Icon name="alert" size={12} color={c.red} /> : null}
          <Text style={styles.queuedText}>{t(failed ? 'conversation.queuedRefused' : 'conversation.queued')}</Text>
          {onRetry ? <NativeButton label={t('common.retry')} size="small" onPress={onRetry} /> : null}
          {onRemove ? <NativeButton label={t('conversation.removeQueued')} size="small" onPress={onRemove} /> : null}
        </View>
      ) : null}
    </View>
  );
});

export const AssistantReply = memo(function AssistantReply({
  messageId,
  sessionId,
  text,
  steps,
  references,
  live = false,
  working = false,
  runningTool = null,
  answered,
  env,
  actions,
  onSteps,
}: {
  messageId: string;
  sessionId: string | null;
  text: string;
  steps: ToolStep[];
  references?: unknown;
  /** Being written now: unfinished rich blocks show a placeholder. */
  live?: boolean;
  /** The reply is being worked on (sending or following it). */
  working?: boolean;
  /** The tool running now (live reply). */
  runningTool?: string | null;
  /** A later message of mine exists (its questions were answered). */
  answered: boolean;
  env: RichEnv;
  actions?: MessageActions;
  /** Open the steps sheet for this reply. */
  onSteps?: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const openObject = useOpenObject();
  const cards = useMemo(() => replyCards(steps, messageId, text), [steps, messageId, text]);
  const objects = useMemo(() => citedObjects(references, steps), [references, steps]);
  const busy = live && working;
  const activity =
    toolActivity(steps, live ? runningTool : null, t) ?? (busy && !text ? t('assistant.thinking') : null);
  const running = busy && (!!runningTool || !text || steps.some((step) => step.status === 'running'));
  // web order: most cards sit above the words; things to save or apply come after them
  const below = (card: (typeof cards)[number]) => card.kind === 'task_capture' || card.kind === 'schema_plan';
  const renderCards = (list: typeof cards) => (
    <>
      {list.map((card) => {
        switch (card.kind) {
          case 'ask_user':
            return <AskUserCard key={card.key} ask={card.ask} answered={answered} onAnswer={env.reply} />;
          case 'file':
            return (
              <FileCard
                key={card.key}
                name={card.name}
                detail={[
                  card.size != null ? formatBytes(card.size) : '',
                  card.rows != null ? t('cards.rows', { n: card.rows }) : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onPress={() => openObject({ kind: 'attachment', path: card.path, name: card.name })}
              />
            );
          case 'image':
            return <GeneratedImage key={card.key} url={card.url} prompt={card.prompt} />;
          case 'task_capture':
            return (
              <TaskCaptureCard key={card.key} capture={card.capture} actionKey={card.actionKey} sessionId={sessionId} />
            );
          case 'schema_plan':
            return <SchemaPlanCard key={card.key} plan={card.plan} actionKey={card.actionKey} sessionId={sessionId} />;
          case 'extension':
            return <ExtensionCard key={card.key} title={card.title} summary={card.summary} url={card.url} />;
        }
      })}
    </>
  );
  const status = activity ? (
    <View style={styles.statusInner}>
      {running ? <Spinner size="small" /> : <Icon name="wrench" size={12} color={c.tertiaryLabel} />}
      <Text style={styles.statusText} numberOfLines={1}>
        {activity}
      </Text>
      {steps.length ? <Icon name="chevR" size={10} weight="semibold" color={c.tertiaryLabel} /> : null}
    </View>
  ) : null;
  return (
    <View style={styles.reply}>
      {/* one row, one height: the status changes words in place, never the rows below */}
      <View style={styles.author}>
        <AssistantAvatar size={28} />
        <Text style={styles.authorName} numberOfLines={1}>
          {t('conversation.assistant')}
        </Text>
        <View style={styles.status} accessibilityLiveRegion={live ? 'polite' : 'none'}>
          {status && steps.length && onSteps ? (
            <Touchable
              onPress={onSteps}
              style={styles.statusButton}
              accessibilityRole="button"
              accessibilityLabel={activity ?? undefined}
            >
              {status}
            </Touchable>
          ) : (
            status
          )}
        </View>
      </View>
      {renderCards(cards.filter((card) => !below(card)))}
      <RichContext.Provider value={env}>
        {text ? (
          <MessageMenu text={text} actions={actions}>
            <View>
              <Markdown source={text} animated={live} />
            </View>
          </MessageMenu>
        ) : null}
      </RichContext.Provider>
      {renderCards(cards.filter(below))}
      <ObjectCards objects={objects} />
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  userRow: { alignItems: 'flex-end', gap: space.xxs },
  bubbleLine: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    gap: space.xs,
  },
  // the menu's wrapper carries the cap: a percentage on the bubble inside it would shrink twice
  bubbleSlot: { maxWidth: '80%' },
  mark: { paddingBottom: space.xs },
  bubble: {
    paddingHorizontal: space.md + space.xxs,
    paddingVertical: space.sm + space.xxs,
    borderRadius: radius.bubble,
    backgroundColor: c.accentFill,
    ...squircle,
  },
  queued: { opacity: 0.6 },
  userText: { ...typo.body, color: c.label },
  queuedLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  queuedText: { ...typo.footnote, color: c.secondaryLabel },
  reply: { alignSelf: 'stretch' },
  author: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginBottom: space.sm,
    minHeight: HIT - space.sm,
  },
  authorName: { ...typo.subheadline, fontWeight: weight.semibold, color: c.secondaryLabel, flexShrink: 0 },
  status: { flex: 1, alignItems: 'flex-end' },
  statusButton: { minHeight: HIT - space.sm, justifyContent: 'center' },
  statusInner: { flexDirection: 'row', alignItems: 'center', gap: space.xs, maxWidth: '100%' },
  statusText: { ...typo.footnote, color: c.secondaryLabel, flexShrink: 1 },
}));
