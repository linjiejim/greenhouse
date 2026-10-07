/**
 * `DocRow` — one document in the knowledge list, laid out like a Mail / Notes
 * row on the plain list geometry of src/ui/list.tsx (16-pt margins, `LIST_TILE`
 * glyph, `separatorInset()` to the text, `fill` press highlight): a tinted
 * scope glyph, the title,
 * up to two lines of summary and a footnote meta line ((legacy) category ·
 * updated · read-only marker); the scope is the glyph (and part of the a11y
 * label). The row's context menu (open / preview / edit / history) comes from
 * wrapping it in `NativeMenu trigger="longPress"` — see app/knowledge/index.tsx.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { KnowledgeDoc } from '../api/knowledge';
import { relativeTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme } from '../theme';
import { Icon } from '../ui/core';
import { LIST_TILE, separatorInset } from '../ui/list';
import { SCOPE_ICON, SCOPE_LABEL, docCategory, docScope, scopeTint } from './scope';

const TILE = LIST_TILE;

export function DocRow({ doc, onPress, last }: { doc: KnowledgeDoc; onPress: () => void; last?: boolean }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const scope = docScope(doc);
  const tint = scopeTint(scope, c);
  const meta = [docCategory(doc), relativeTime(doc.updated_at)].filter(Boolean).join(' · ');
  const readOnly = doc.access === 'reader';
  return (
    <Pressable
      onPress={onPress}
      testID={`kb-doc-${doc.slug}`}
      accessibilityRole="button"
      accessibilityLabel={[doc.title, doc.summary, t(SCOPE_LABEL[scope]), meta, readOnly ? t('knowledge.readOnly') : '']
        .filter(Boolean)
        .join(', ')}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.fill }]}
    >
      <View style={[styles.tile, { backgroundColor: tint.bg }]}>
        <Icon name={SCOPE_ICON[scope]} size={16} weight="medium" color={tint.fg} />
      </View>
      <View style={styles.body}>
        <Text numberOfLines={1} style={styles.title}>
          {doc.title}
        </Text>
        {doc.summary ? (
          <Text numberOfLines={2} style={styles.summary}>
            {doc.summary}
          </Text>
        ) : null}
        <View style={styles.metaRow}>
          <Text numberOfLines={1} style={styles.meta}>
            {meta}
          </Text>
          {readOnly ? (
            <View style={styles.readOnly}>
              <Icon name="eye" size={11} weight="semibold" color={c.secondaryLabel} />
              <Text style={styles.meta}>{t('knowledge.readOnly')}</Text>
            </View>
          ) : null}
        </View>
      </View>
      {!last ? <View pointerEvents="none" style={styles.sep} /> : null}
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: space.margin, gap: space.md },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: radius.sm,
    marginTop: 11,
    alignItems: 'center',
    justifyContent: 'center',
    ...squircle,
  },
  body: { flex: 1, minWidth: 0, paddingVertical: 11, paddingRight: space.margin },
  title: { ...typo.headline, color: c.label },
  summary: { ...typo.subheadline, color: c.secondaryLabel, marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 4 },
  meta: { ...typo.footnote, color: c.secondaryLabel, flexShrink: 1 },
  readOnly: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  sep: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: separatorInset(TILE),
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.separator,
  },
}));
