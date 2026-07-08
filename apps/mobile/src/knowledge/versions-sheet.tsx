/**
 * KnowledgeVersionsSheet — a doc's edit history as a bottom sheet. Each row
 * shows what THAT change did (which fields, char delta vs the previous
 * snapshot — versions come back newest-first) with a tap-to-expand rendered
 * snapshot. Restore is non-destructive (the server records the rollback as a
 * new version) and is offered only to editors, mirroring the web dialog.
 * No inputs here, so the sheet needs no keyboard handling.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { listVersions, restoreVersion, type KnowledgeDoc, type KnowledgeDocVersion } from '../api/knowledge';
import { Markdown } from '../chat/markdown';
import { relativeTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { font, makeStyles, radius, useTheme, weight } from '../theme';
import { EmptyState, Sheet, Skeleton, Spinner, Touchable } from '../ui';

type ChangedField = 'title' | 'content' | 'summary';

/** Which top-level fields differ between the previous snapshot and this one. */
function changedFields(before: KnowledgeDocVersion | undefined, after: KnowledgeDocVersion): ChangedField[] {
  const fields: ChangedField[] = [];
  if ((before?.title ?? '') !== after.title) fields.push('title');
  if ((before?.content_markdown ?? '') !== (after.content_markdown ?? '')) fields.push('content');
  if ((before?.summary ?? '') !== (after.summary ?? '')) fields.push('summary');
  return fields;
}

export function KnowledgeVersionsSheet({
  doc,
  canRestore,
  visible,
  onClose,
  onRestored,
}: {
  doc: KnowledgeDoc;
  /** Restore needs write access (server re-checks). */
  canRestore: boolean;
  visible: boolean;
  onClose: () => void;
  onRestored: (doc: KnowledgeDoc) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [versions, setVersions] = useState<KnowledgeDocVersion[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setVersions(await listVersions(doc.id));
  }, [doc.id]);

  useEffect(() => {
    if (visible) {
      setVersions(null);
      setExpanded(null);
      void reload();
    }
  }, [visible, reload]);

  function confirmRestore(v: KnowledgeDocVersion) {
    Alert.alert(t('knowledge.restoreTitle', { n: v.version }), t('knowledge.restoreHint'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('knowledge.restore'),
        onPress: async () => {
          setRestoring(v.version);
          const restored = await restoreVersion(doc.id, v.version);
          setRestoring(null);
          if (!restored) {
            Alert.alert(t('knowledge.restoreFailed'));
            return;
          }
          onRestored(restored);
          setExpanded(null);
          void reload();
        },
      },
    ]);
  }

  const fieldLabel: Record<ChangedField, string> = {
    title: t('knowledge.fieldTitle'),
    content: t('knowledge.fieldContent'),
    summary: t('knowledge.fieldSummary'),
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('knowledge.history')} heightPct={85} nativeScroll>
      {versions === null ? (
        <View style={{ padding: 16, gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} style={{ height: 84, borderRadius: radius.lg }} />
          ))}
        </View>
      ) : versions.length === 0 ? (
        <EmptyState icon="clock" title={t('knowledge.noVersions')} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
          {versions.map((v, idx) => {
            const isLatest = idx === 0;
            // Newest-first, so idx+1 is the snapshot this change was made against.
            const prev = versions[idx + 1];
            const fields = changedFields(prev, v);
            const charDelta = (v.content_markdown || '').length - (prev?.content_markdown || '').length;
            const open = expanded === v.version;
            return (
              <View key={v.id} style={styles.card}>
                <View style={styles.rowTop}>
                  <Text style={styles.version}>v{v.version}</Text>
                  {isLatest ? <Text style={styles.currentTag}>{t('knowledge.current')}</Text> : null}
                  <View style={{ flex: 1 }} />
                  <Text style={styles.time}>{relativeTime(v.created_at)}</Text>
                </View>
                <Text numberOfLines={2} style={styles.reason}>
                  {prev ? v.change_reason || t('knowledge.updatedReason') : t('knowledge.initialVersion')}
                </Text>
                {(fields.length > 0 || charDelta !== 0) && (
                  <View style={styles.badgeRow}>
                    {fields.map((f) => (
                      <View key={f} style={styles.badge}>
                        <Text style={styles.badgeText}>{fieldLabel[f]}</Text>
                      </View>
                    ))}
                    {charDelta !== 0 ? (
                      <Text style={[styles.delta, { color: charDelta > 0 ? c.accentDeep : c.danger }]}>
                        {charDelta > 0 ? '+' : '−'}
                        {Math.abs(charDelta)} {t('knowledge.charsWord')}
                      </Text>
                    ) : null}
                  </View>
                )}
                <View style={styles.actions}>
                  <Touchable haptic="none" onPress={() => setExpanded(open ? null : v.version)} style={styles.actionBtn} pressedStyle={{ opacity: 0.6 }}>
                    <Text style={styles.actionText}>{open ? t('knowledge.hideSnapshot') : t('knowledge.viewSnapshot')}</Text>
                  </Touchable>
                  {!isLatest && canRestore ? (
                    restoring === v.version ? (
                      <View style={styles.actionBtn}>
                        <Spinner size={14} />
                      </View>
                    ) : (
                      <Touchable haptic="light" onPress={() => confirmRestore(v)} style={styles.actionBtn} pressedStyle={{ opacity: 0.6 }}>
                        <Text style={[styles.actionText, { color: c.accent }]}>{t('knowledge.restore')}</Text>
                      </Touchable>
                    )
                  ) : null}
                </View>
                {open ? (
                  <View style={styles.snapshot}>
                    <Text style={styles.snapshotTitle}>{v.title}</Text>
                    <Markdown source={v.content_markdown || ''} />
                  </View>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
      )}
    </Sheet>
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.hairline,
    padding: 13,
    marginBottom: 10,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  version: { fontSize: font.body, fontWeight: weight.bold, color: c.fg },
  currentTag: { fontSize: font.caption, color: c.accentDeep, fontWeight: weight.semibold },
  time: { fontSize: font.caption, color: c.fgFaint },
  reason: { fontSize: font.small, color: c.fgMuted, marginTop: 4, lineHeight: 18 },

  badgeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  badge: { backgroundColor: c.surfaceMuted, borderRadius: radius.full, paddingVertical: 2, paddingHorizontal: 8 },
  badgeText: { fontSize: font.caption, color: c.fgMuted, fontWeight: weight.medium },
  delta: { fontSize: font.caption, fontWeight: weight.semibold },

  actions: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 },
  actionBtn: { paddingVertical: 5, paddingRight: 14 },
  actionText: { fontSize: font.label, fontWeight: weight.semibold, color: c.fgMuted },

  snapshot: {
    marginTop: 6,
    backgroundColor: c.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  snapshotTitle: { fontSize: font.title, fontWeight: weight.bold, color: c.fg, marginBottom: 4 },
}));
