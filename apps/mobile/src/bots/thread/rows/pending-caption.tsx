/**
 * The Messages-style caption under a send this device has in flight (spec
 * §2.5.3 d), right-aligned under the bubble:
 *
 *  - sending — "Sending…", only once it takes longer than a beat (a quick
 *    send shouldn't flash it);
 *  - delivered while Bots are busy — "Delivered · Read after the current
 *    reply" + "Handle Now" (while a run is going): the current step finishes,
 *    then this message is read;
 *  - asked to be read next (Handle Now, or a soft stop) — "Up next";
 *  - not delivered (the POST got no answer) — a red "Not Delivered"; tap for
 *    Try Again (the engine reloads first: a send the server already has is
 *    just marked sent, never sent twice) or Delete (the local bubble only).
 *
 * Sent → nothing (the bubble becomes an ordinary message on the next reload).
 */

import React, { memo, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useT } from '../../../lib/i18n';
import { HIT, makeStyles, space, typo, useTheme, weight } from '../../../theme';
import { Icon } from '../../../ui/core';
import { NativeMenu, type MenuItem } from '../../../ui/menu';
import type { MobilePending } from '../../contract';

/** How long a send may take before "Sending…" shows. */
const SENDING_GRACE_MS = 600;
/** The caption's drawn height (a footnote line in a 24-pt row). */
const CAPTION_H = 24;
/**
 * "Not Delivered" is the only way to retry or delete a send: its trigger is a
 * full `HIT` tall (the menu host takes its child's size and has no hitSlop),
 * and negative margins hand the extra back so the caption sits where it did.
 */
const FAILED_PAD = (HIT - CAPTION_H) / 2;

export const PendingCaption = memo(function PendingCaption({
  pending,
  runActive,
  upNext,
  onHandleNow,
  onRetry,
  onDiscard,
}: {
  pending: MobilePending;
  runActive: boolean;
  /** The run already stops after the current step (a soft stop is on its way). */
  upNext: boolean;
  onHandleNow: (clientId: string) => void;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const sending = pending.status === 'sending' && !pending.failed;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!sending) return;
    const timer = setTimeout(() => setSlow(true), SENDING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [sending]);
  const items = useMemo<MenuItem[]>(
    () => [
      { id: 'retry', title: t('bots.pending.tryAgain'), icon: 'refresh' },
      { id: 'delete', title: t('bots.pending.delete'), icon: 'trash', destructive: true },
    ],
    [t],
  );

  if (pending.failed) {
    return (
      <NativeMenu
        items={items}
        onSelect={(id) => (id === 'retry' ? onRetry(pending.clientId) : onDiscard(pending.clientId))}
        style={styles.failedHost}
      >
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel={t('bots.pending.notDelivered')}
          style={[styles.row, styles.tap]}
        >
          <Icon name="alertCircle" size={13} weight="semibold" color={c.red} />
          <Text style={[styles.text, styles.failed]}>{t('bots.pending.notDelivered')}</Text>
        </View>
      </NativeMenu>
    );
  }
  if (sending) {
    return slow ? <Text style={[styles.text, styles.row]}>{t('bots.pending.sending')}</Text> : null;
  }
  if (pending.status !== 'queued') return null;
  if (pending.nudged || upNext) return <Text style={[styles.text, styles.row]}>{t('bots.pending.next')}</Text>;
  return (
    <View style={styles.row}>
      <Text style={styles.text}>{t('bots.pending.delivered')}</Text>
      {runActive ? (
        <Pressable
          onPress={() => onHandleNow(pending.clientId)}
          hitSlop={{ top: (HIT - 18) / 2, bottom: (HIT - 18) / 2, left: space.sm, right: space.sm }}
          accessibilityRole="button"
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Text style={styles.action}>{t('bots.pending.handleNow')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    columnGap: space.sm,
    rowGap: space.xxs,
    marginTop: space.xs,
  },
  // the trigger: HIT tall, its row margin moved out to the menu host (below)
  tap: { minHeight: HIT, paddingVertical: FAILED_PAD, marginTop: 0, gap: space.xs },
  failedHost: { marginTop: space.xs - FAILED_PAD, marginBottom: -FAILED_PAD },
  text: { ...typo.footnote, color: c.secondaryLabel, textAlign: 'right' },
  failed: { color: c.red, fontWeight: weight.medium },
  action: { ...typo.footnote, fontWeight: weight.semibold, color: c.accent },
  pressed: { opacity: 0.55 },
}));
