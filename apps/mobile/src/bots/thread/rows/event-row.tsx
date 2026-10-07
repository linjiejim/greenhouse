/**
 * A system line in a Bots thread — who joined or left, a Bot created, a task
 * started, a sign-in done, the computer handed back, new instructions, a
 * stop, nobody able to answer, a later line about a card ("declined") — small,
 * centred and quiet: scaffolding around the talk. Only a line that needs a
 * decision carries an action: a failed turn offers Retry (an honest new
 * message "@Name Please try that again."), a hit limit offers Continue. The
 * summary marker is a thin rule: "Earlier messages were summarized · View"
 * (→ the conversation info, where the digest lives). Text comes from the
 * server (its `content`, in the account's language); the icon from the
 * event's kind.
 */

import React, { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useT } from '../../../lib/i18n';
import type { BotEvent, BotMessage, BotRequestKind } from '../../../shared/bots';
import { HIT, makeStyles, space, typo, useTheme, weight } from '../../../theme';
import { NativeButton } from '../../../ui/button';
import { Icon, type IconName } from '../../../ui/core';

const EVENT_ICON: Partial<Record<BotEvent['kind'], IconName>> = {
  joined: 'userPlus',
  left: 'personMinus',
  created: 'sparkle',
  task_started: 'hourglass',
  login_done: 'unlock',
  takeover_done: 'hand',
  takeover_released: 'hand',
  instructions_updated: 'file',
  stopped: 'stopCircle',
  unavailable: 'sleep',
  limit: 'alert',
  turn_error: 'alert',
};

/** A later line about a card wears the card's icon. */
const REQUEST_ICON: Record<BotRequestKind, IconName> = {
  approval: 'shieldCheck',
  login: 'lock',
  takeover: 'hand',
  bot_create: 'sparkle',
  task_start: 'hourglass',
  instructions_update: 'file',
};

const REPORT_ICON: Record<'succeeded' | 'failed' | 'canceled', IconName> = {
  succeeded: 'checkCircle',
  failed: 'statusCancelled',
  canceled: 'stopCircle',
};

function iconOf(event: BotEvent | null): IconName | null {
  if (!event) return null;
  if (event.kind === 'request') return REQUEST_ICON[event.request_kind] ?? null;
  if (event.kind === 'task_report') return REPORT_ICON[event.status] ?? null;
  return EVENT_ICON[event.kind] ?? null;
}

export const EventRow = memo(function EventRow({
  message,
  event,
  failedBotName,
  canAct,
  busy,
  onRetry,
  onContinue,
  onViewSummary,
}: {
  message: BotMessage;
  event: BotEvent | null;
  /** The Bot whose turn failed (`turn_error`), when known — the fallback text and the Retry address it. */
  failedBotName: string | null;
  /** Someone can reply here (no one-click lines in a read-only thread). */
  canAct: boolean;
  /** A run is going: a retry now would only queue behind it. */
  busy: boolean;
  onRetry: (botId: string) => void;
  onContinue: () => void;
  onViewSummary: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();

  if (event?.kind === 'digest') {
    return (
      <View style={styles.rule}>
        <View style={styles.hairline} />
        <Text style={styles.ruleText}>{t('bots.thread.summarized')}</Text>
        <Pressable
          onPress={onViewSummary}
          hitSlop={{ top: (HIT - 18) / 2, bottom: (HIT - 18) / 2, left: space.sm, right: space.sm }}
          accessibilityRole="button"
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Text style={styles.link}>{t('bots.thread.view')}</Text>
        </Pressable>
        <View style={styles.hairline} />
      </View>
    );
  }

  const danger = event?.kind === 'turn_error' || (event?.kind === 'task_report' && event.status === 'failed');
  const icon = iconOf(event);
  const text =
    message.content ||
    (event?.kind === 'turn_error'
      ? t('bots.thread.turnFailed', { name: failedBotName ?? t('bots.common.deletedBot') })
      : '');
  const retryBot = event?.kind === 'turn_error' && failedBotName && canAct ? event.bot_id : null;
  const tint = danger ? c.red : c.secondaryLabel;
  return (
    <View style={styles.wrap}>
      <View style={styles.line}>
        {icon ? <Icon name={icon} size={12} weight="medium" color={tint} /> : null}
        <Text style={[styles.text, { color: tint }]}>{text}</Text>
      </View>
      {retryBot ? (
        <NativeButton
          label={t('bots.thread.retry')}
          icon="refresh"
          size="small"
          disabled={busy}
          onPress={() => onRetry(retryBot)}
        />
      ) : event?.kind === 'limit' && canAct ? (
        <NativeButton label={t('bots.thread.continue')} size="small" disabled={busy} onPress={onContinue} />
      ) : null}
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  wrap: { alignItems: 'center', gap: space.xs + 2, paddingHorizontal: space.xxl, paddingVertical: space.sm },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs + 2, maxWidth: '100%' },
  text: { flexShrink: 1, ...typo.caption1, textAlign: 'center' },
  rule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.margin,
    paddingVertical: space.md,
  },
  hairline: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: c.separator },
  ruleText: { ...typo.caption1, color: c.secondaryLabel },
  link: { ...typo.caption1, fontWeight: weight.semibold, color: c.accent },
  pressed: { opacity: 0.55 },
}));
