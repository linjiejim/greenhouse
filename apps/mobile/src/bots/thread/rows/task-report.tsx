/**
 * A background task's report — the Bot speaking after working on its own, so
 * it reads like that Bot's reply (the chat's `AiMessage`: full-width markdown,
 * tables, links, the copy / share menu) under a line that says which task it
 * closes and how it ended: "Background task · Meeting notes  [Done]". The
 * speaker line always shows (a report interrupts whatever came before).
 */

import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { AiMessage } from '../../../chat/message';
import { useT, type TranslationKey } from '../../../lib/i18n';
import type { BotEvent, BotMessage, BotView } from '../../../shared/bots';
import { makeStyles, space, typo, useTheme } from '../../../theme';
import { Badge, type BadgeTone } from '../../../ui/list';
import { fromBotMessage } from '../adapters';
import { SpeakerLine } from './speaker-line';
import type { ReplyHandlers } from './turns';

type TaskReportEvent = Extract<BotEvent, { kind: 'task_report' }>;

const STATUS: Record<TaskReportEvent['status'], { tone: BadgeTone; key: TranslationKey }> = {
  succeeded: { tone: 'green', key: 'bots.thread.reportDone' },
  failed: { tone: 'red', key: 'bots.thread.reportFailed' },
  canceled: { tone: 'neutral', key: 'bots.thread.taskCanceled' },
};

const noReply = async () => false;
const noRetry = () => {};

export const TaskReport = memo(function TaskReport({
  message,
  event,
  bot,
  loaded,
  readOnly,
  handlers,
  onOpenProfile,
}: {
  message: BotMessage;
  event: TaskReportEvent;
  bot: BotView | undefined;
  loaded: boolean;
  readOnly: boolean;
  handlers: ReplyHandlers;
  onOpenProfile: (botId: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const status = STATUS[event.status] ?? STATUS.failed;
  return (
    <View>
      <SpeakerLine bot={bot} loaded={loaded} onPress={onOpenProfile} />
      <View style={styles.meta}>
        <Text numberOfLines={2} style={styles.title}>
          {t('bots.thread.taskReport', { title: event.title })}
        </Text>
        <Badge label={t(status.key)} tone={status.tone} />
      </View>
      <AiMessage
        msg={fromBotMessage(message)}
        isLatest={false}
        readOnly={readOnly}
        onOpenTools={handlers.onOpenTools}
        onOpenReasoning={handlers.onOpenReasoning}
        onOpenRefs={handlers.onOpenRefs}
        onAction={handlers.onAction}
        onRetry={noRetry}
        onReply={noReply}
        allowRegenerate={false}
      />
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.margin,
    paddingTop: space.xxs,
    paddingBottom: space.xs,
  },
  title: { flexShrink: 1, ...typo.caption1, color: c.secondaryLabel },
}));
