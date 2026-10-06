/**
 * `VersionRow` — one entry in a doc's edit history (app/knowledge/versions.tsx).
 *
 * Shows what THAT change did relative to the previous snapshot (versions come
 * newest-first, so the previous one is the next item): version number (+ 当前
 * on the newest), author · reason, relative time, field badges (标题 / 正文 /
 * 摘要) and the content's character delta. Tap toggles a disclosure that
 * reveals the restore button (`NativeButton`, spinner while restoring) and
 * the rendered snapshot; long-press gives the same actions as a system context
 * menu. Plain rows on the sheet material — only the expanded snapshot sits on
 * a fill; 当前 and the field badges are the shared `Badge`. No word-level diff
 * (web-only).
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { KnowledgeDocVersion } from '../api/knowledge';
import { Markdown } from '../chat/markdown';
import { relativeTime } from '../lib/format';
import { useT, type TFunction, type TranslationKey } from '../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { NativeButton } from '../ui/button';
import { Icon } from '../ui/core';
import { Badge } from '../ui/list';
import { NativeMenu, menuSections, type MenuItem } from '../ui/menu';
import { withoutTitleHeading } from './doc-body';

type ChangedField = 'title' | 'content' | 'summary';

const FIELD_LABEL: Record<ChangedField, TranslationKey> = {
  title: 'knowledge.fieldTitle',
  content: 'knowledge.fieldContent',
  summary: 'knowledge.fieldSummary',
};

/**
 * The server writes a few machine reasons in English (`Updated from editor`
 * for a plain PUT, the web's `Updated from knowledge editor`, `Restored from
 * vN` for a rollback) — show those localized; free-text reasons stay as-is.
 */
function localizedReason(reason: string, t: TFunction): string {
  if (/^Updated from (knowledge )?editor$/.test(reason)) return t('knowledge.updatedReason');
  const restored = /^Restored from v(\d+)$/.exec(reason);
  return restored ? t('knowledge.restoredFrom', { n: restored[1] }) : reason;
}

/** Which top-level fields differ between the previous snapshot and this one. */
function changedFields(before: KnowledgeDocVersion | undefined, after: KnowledgeDocVersion): ChangedField[] {
  const fields: ChangedField[] = [];
  if ((before?.title ?? '') !== after.title) fields.push('title');
  if ((before?.content_markdown ?? '') !== (after.content_markdown ?? '')) fields.push('content');
  if ((before?.summary ?? '') !== (after.summary ?? '')) fields.push('summary');
  return fields;
}

export function VersionRow({
  version: v,
  prev,
  isLatest,
  author,
  expanded,
  canRestore,
  restoring,
  last,
  width,
  onToggle,
  onRestore,
}: {
  version: KnowledgeDocVersion;
  /** The snapshot this change was made against (undefined for the first version). */
  prev: KnowledgeDocVersion | undefined;
  isLatest: boolean;
  author?: string;
  expanded: boolean;
  /** Restore needs write access (the server re-checks). Never offered on the current version. */
  canRestore: boolean;
  restoring: boolean;
  last?: boolean;
  /** The list's width, when known — lets the context menu skip its measuring pass. */
  width?: number;
  onToggle: () => void;
  onRestore: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const fields = changedFields(prev, v);
  const delta = (v.content_markdown || '').length - (prev?.content_markdown || '').length;
  const reason = prev
    ? v.change_reason
      ? localizedReason(v.change_reason, t)
      : t('knowledge.updatedReason')
    : t('knowledge.initialVersion');
  const restorable = canRestore && !isLatest;

  const menu: MenuItem[] = menuSections([
    [
      {
        id: 'toggle',
        title: expanded ? t('knowledge.hideSnapshot') : t('knowledge.viewSnapshot'),
        icon: 'eye',
      },
    ],
    restorable ? [{ id: 'restore', title: t('knowledge.restoreThis'), icon: 'rotate' }] : [],
  ]);

  return (
    <View>
      <NativeMenu
        trigger="longPress"
        width={width}
        items={menu}
        onSelect={(id) => (id === 'restore' ? onRestore() : onToggle())}
      >
        <Pressable
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.fill }]}
        >
          <View style={styles.top}>
            <Text style={styles.version}>v{v.version}</Text>
            {isLatest ? <Badge label={t('knowledge.current')} tone="accent" style={styles.centered} /> : null}
            <View style={styles.spacer} />
            <Text style={styles.time}>{relativeTime(v.created_at)}</Text>
            <Icon
              name="chevR"
              size={12}
              weight="semibold"
              color={c.tertiaryLabel}
              style={expanded ? styles.chevOpen : undefined}
            />
          </View>
          <Text numberOfLines={2} style={styles.reason}>
            {author ? `${author} · ${reason}` : reason}
          </Text>
          {fields.length > 0 || delta !== 0 ? (
            <View style={styles.badges}>
              {fields.map((f) => (
                <Badge key={f} label={t(FIELD_LABEL[f])} />
              ))}
              {delta !== 0 ? (
                <Text style={[styles.delta, { color: delta > 0 ? c.green : c.red }]}>
                  {delta > 0 ? '+' : '−'}
                  {Math.abs(delta)} {t('knowledge.charsWord')}
                </Text>
              ) : null}
            </View>
          ) : null}
        </Pressable>
      </NativeMenu>

      {expanded ? (
        <View style={styles.expanded}>
          {restorable ? (
            <View style={styles.restoreRow}>
              <NativeButton label={t('knowledge.restoreThis')} icon="rotate" loading={restoring} onPress={onRestore} />
            </View>
          ) : null}
          <View style={styles.snapshot}>
            <Text style={styles.snapshotTitle}>{v.title}</Text>
            <Markdown source={withoutTitleHeading(v.content_markdown || '', v.title)} />
          </View>
        </View>
      ) : null}

      {!last ? <View pointerEvents="none" style={styles.sep} /> : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  row: { paddingHorizontal: space.margin, paddingVertical: space.md - 1 },
  top: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  version: { ...typo.headline, color: c.label },
  centered: { alignSelf: 'center' },
  spacer: { flex: 1 },
  time: { ...typo.footnote, color: c.secondaryLabel },
  chevOpen: { transform: [{ rotate: '90deg' }] },
  reason: { ...typo.subheadline, color: c.secondaryLabel, marginTop: 2 },
  badges: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.xs + 2, marginTop: space.xs + 2 },
  delta: { ...typo.caption1, fontWeight: weight.semibold },
  expanded: { paddingHorizontal: space.margin, paddingBottom: space.md, gap: space.md },
  restoreRow: { alignItems: 'flex-start' },
  snapshot: {
    backgroundColor: c.tertiaryFill,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    ...squircle,
  },
  snapshotTitle: { ...typo.headline, color: c.label, marginBottom: space.xs },
  sep: {
    marginLeft: space.margin,
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.separator,
  },
}));
