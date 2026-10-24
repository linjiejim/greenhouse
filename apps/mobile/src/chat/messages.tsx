/**
 * The rows of a conversation (content layer — solid colors, never glass):
 *
 *  - `UserMessage` — my words in a light bubble on the right, my pictures and attached files
 *    under it (the ```attachments fence never shows as text). A message still waiting for the
 *    station (queued offline) says so, with a retry.
 *  - `AssistantReply` — the reply without a bubble, in the order a reply reads: the sprout and
 *    "助手" (its face follows the turn: thinking, speaking, waiting for me, done, error), the
 *    tools used folded into one line, the words with their rich blocks and link chips, then the
 *    cards (questions, files, pictures, things to save or apply, extension cards) and the
 *    objects it cites or wrote.
 *
 * Long press on either copies the words.
 */

import React, { memo, useMemo } from 'react';
import { Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useT } from '../lib/i18n';
import { Markdown, RichContext, type RichEnv } from '../markdown';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { AssistantAvatar } from '../ui/avatar';
import { NativeButton } from '../ui/button';
import { Icon } from '../ui/core';
import { NativeMenu } from '../ui/menu';
import type { PlantStateInput } from '../ui/plant-avatar/plant-ids';
import { toast } from '../ui/toast';
import { AskUserCard, AttachmentRow, ExtensionCard, FileCard, GeneratedImage, MessageImages, ObjectCards, SchemaPlanCard, TaskCaptureCard, ToolSummary } from './cards';
import { formatBytes } from '../lib/format';
import { useOpenObject } from '../shell/open-object';
import { citedObjects, replyCards, type AttachedFile, type ToolStep } from './parts';

/** A tool's name for people: `knowledge_query` → "Knowledge query". */
export function toolLabel(tool: string): string {
  const words = tool.replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : tool;
}

function CopyMenu({ text, children }: { text: string; children: React.ReactNode }) {
  const t = useT();
  return (
    <NativeMenu
      trigger="longPress"
      items={[{ id: 'copy', title: t('markdown.copy'), icon: 'copy' }]}
      onSelect={() => {
        void Clipboard.setStringAsync(text);
        toast(t('markdown.copied'), 'copy');
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
  onRetry,
}: {
  text: string;
  images: { id: string; url: string }[];
  files: AttachedFile[];
  /** Waiting for the station (sent offline). */
  queued?: boolean;
  onRetry?: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <View style={styles.userRow}>
      {text ? (
        <CopyMenu text={text}>
          <View style={[styles.bubble, queued && styles.queued]}>
            <Text style={styles.userText} selectable>
              {text}
            </Text>
          </View>
        </CopyMenu>
      ) : null}
      <MessageImages images={images} align="end" />
      <AttachmentRow files={files} align="end" />
      {queued ? (
        <View style={styles.queuedLine}>
          <Icon name="clock" size={12} color={c.secondaryLabel} />
          <Text style={styles.queuedText}>{t('conversation.queued')}</Text>
          {onRetry ? <NativeButton label={t('common.retry')} size="small" onPress={onRetry} /> : null}
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
  state,
  live = false,
  answered,
  env,
}: {
  messageId: string;
  sessionId: string | null;
  text: string;
  steps: ToolStep[];
  references?: unknown;
  /** The sprout's face for this reply (the latest one moves; older ones rest). */
  state: PlantStateInput;
  /** Being written now: unfinished rich blocks show a placeholder. */
  live?: boolean;
  /** A later message of mine exists (its questions were answered). */
  answered: boolean;
  env: RichEnv;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const openObject = useOpenObject();
  const cards = useMemo(() => replyCards(steps, messageId, text), [steps, messageId, text]);
  const objects = useMemo(() => citedObjects(references, steps), [references, steps]);
  return (
    <View style={styles.reply}>
      <View style={styles.author}>
        <AssistantAvatar size={28} state={state} animate={state !== 'idle'} />
        <Text style={styles.authorName}>{t('conversation.assistant')}</Text>
      </View>
      <ToolSummary steps={steps} toolName={toolLabel} />
      <RichContext.Provider value={env}>
        {text ? (
          <CopyMenu text={text}>
            <View>
              <Markdown source={text} animated={live} />
            </View>
          </CopyMenu>
        ) : null}
      </RichContext.Provider>
      {cards.map((card) => {
        switch (card.kind) {
          case 'ask_user':
            return <AskUserCard key={card.key} ask={card.ask} answered={answered} onAnswer={env.reply} />;
          case 'file':
            return (
              <FileCard
                key={card.key}
                name={card.name}
                detail={[card.size != null ? formatBytes(card.size) : '', card.rows != null ? t('cards.rows', { n: card.rows }) : '']
                  .filter(Boolean)
                  .join(' · ')}
                onPress={() => openObject({ kind: 'attachment', path: card.path, name: card.name })}
              />
            );
          case 'image':
            return <GeneratedImage key={card.key} url={card.url} prompt={card.prompt} />;
          case 'task_capture':
            return <TaskCaptureCard key={card.key} capture={card.capture} actionKey={card.actionKey} sessionId={sessionId} />;
          case 'schema_plan':
            return <SchemaPlanCard key={card.key} plan={card.plan} actionKey={card.actionKey} sessionId={sessionId} />;
          case 'extension':
            return <ExtensionCard key={card.key} title={card.title} summary={card.summary} url={card.url} />;
        }
      })}
      <ObjectCards objects={objects} />
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  userRow: { alignItems: 'flex-end', gap: space.xxs },
  bubble: {
    maxWidth: '85%',
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
  author: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  authorName: { ...typo.subheadline, fontWeight: weight.semibold, color: c.secondaryLabel },
}));
