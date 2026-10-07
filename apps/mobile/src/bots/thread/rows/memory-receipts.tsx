/**
 * Memory receipts (spec §2.5.10, the web's memory-receipts.tsx) — a quiet,
 * undoable line under every Bot reply that wrote a memory: "Remembered (only
 * Fern) · prefers bullet points  Undo". Silent memory writes are how an
 * assistant stops being trustworthy; the line names who will read it (every
 * Bot, or only this one). Undo deletes a Bot's own memory or archives the
 * member's; one that is already gone counts as undone.
 *
 * "Undone" lives at module scope: a receipt is drawn by the live segment, then
 * by the persisted reply once the run settles, and again on every remount —
 * no single instance can hold it. The server's `memory_states` (the
 * conversation page's) covers a reload: anything not standing reads undone.
 */

import React, { memo, useState, useSyncExternalStore } from 'react';
import { Pressable, Text, View } from 'react-native';
import { archiveUserMemory, deleteBotMemory } from '../../../api/bots';
import { useT } from '../../../lib/i18n';
import { HIT, makeStyles, space, typo, useTheme, weight } from '../../../theme';
import { Icon } from '../../../ui/core';
import { alertError } from '../../../ui/dialogs';
import type { MemoryReceipt } from '../../vendor/web-helpers';

const undone = new Set<number>();
const listeners = new Set<() => void>();
let version = 0;

function markUndone(memoryId: number): void {
  if (undone.has(memoryId)) return;
  undone.add(memoryId);
  version += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Statuses (`memory_states`) under which a memory still stands. */
const STANDING = new Set(['active', 'dormant']);

export const MemoryReceipts = memo(function MemoryReceipts({
  receipts,
  botId,
  botName,
  memoryStates,
  readOnly,
}: {
  receipts: MemoryReceipt[];
  botId: string | null;
  /** undefined: a Bot the directory doesn't know. */
  botName: string | undefined;
  /** Current status of each memory id, when the server sent it. */
  memoryStates: Readonly<Record<string, string>>;
  readOnly: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  useSyncExternalStore(subscribe, () => version);
  const [busy, setBusy] = useState<number | null>(null);
  if (!receipts.length) return null;

  const undo = async (receipt: MemoryReceipt) => {
    setBusy(receipt.memoryId);
    const res =
      receipt.scope === 'bot' && botId
        ? await deleteBotMemory(botId, receipt.memoryId)
        : await archiveUserMemory(receipt.memoryId);
    setBusy(null);
    // Already gone (undone elsewhere, forgotten from the profile): the member's intent holds.
    if (res.ok || res.status === 404) markUndone(receipt.memoryId);
    else alertError(t('bots.thread.undoMemoryFailed'), res.message || undefined);
  };

  return (
    <View style={styles.wrap}>
      {receipts.map((receipt) => {
        const state = memoryStates[String(receipt.memoryId)];
        const isUndone = undone.has(receipt.memoryId) || (state !== undefined && !STANDING.has(state));
        const scope =
          receipt.scope === 'bot'
            ? t('bots.thread.rememberedBot', { name: botName ?? t('bots.common.deletedBot') })
            : t('bots.thread.rememberedAll');
        return (
          <View key={receipt.memoryId} style={styles.row}>
            <Icon name="brain" size={12} weight="medium" color={isUndone ? c.tertiaryLabel : c.accent} />
            <Text numberOfLines={1} style={[styles.text, isUndone && styles.undone]}>
              <Text style={styles.scope}>{isUndone ? t('bots.thread.memoryUndone') : scope}</Text>
              {receipt.title ? ` · ${receipt.title}` : ''}
            </Text>
            {!isUndone && !readOnly ? (
              <Pressable
                onPress={() => void undo(receipt)}
                disabled={busy === receipt.memoryId}
                hitSlop={{ top: (HIT - 16) / 2, bottom: (HIT - 16) / 2, left: space.sm, right: space.sm }}
                accessibilityRole="button"
                accessibilityLabel={`${t('bots.thread.undoMemory')}, ${receipt.title || scope}`}
                style={({ pressed }) => (pressed || busy === receipt.memoryId) && styles.pressed}
              >
                <Text style={styles.action}>{t('bots.thread.undoMemory')}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  // tucked under the reply above it (the reply keeps its own bottom spacing)
  wrap: { marginTop: -space.sm, paddingHorizontal: space.margin, paddingBottom: space.md, gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  text: { flexShrink: 1, ...typo.caption1, color: c.secondaryLabel },
  scope: { fontWeight: weight.medium },
  undone: { color: c.tertiaryLabel, textDecorationLine: 'line-through' },
  action: { ...typo.caption1, fontWeight: weight.semibold, color: c.accent },
  pressed: { opacity: 0.5 },
}));
