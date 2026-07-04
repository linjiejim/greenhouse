/**
 * TagFilter — a horizontal, scrollable filter bar for the history list:
 * a leading "All" pill + one pill per tag (dot + name). Selecting a tag filters
 * the session list to that tag (GET /api/sessions?tag_id=…); re-tapping the
 * active tag clears it. Renders nothing when the user has no tags.
 */

import React, { useEffect } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTags } from '../store/tags';
import { useT } from '../lib/i18n';
import { DEFAULT_TAG_COLOR, withAlpha } from '../lib/tag-colors';
import { font, makeStyles, radius, useTheme } from '../theme';
import { Touchable } from '../ui';

export function TagFilter({ activeId, onChange }: { activeId: number | null; onChange: (id: number | null) => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const tags = useTags((s) => s.tags);
  const load = useTags((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  if (!tags.length) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.bar}
    >
      <Touchable
        haptic="selection"
        onPress={() => onChange(null)}
        style={[styles.pill, activeId == null ? styles.allActive : styles.inactive]}
      >
        <Text style={[styles.label, { color: activeId == null ? c.accentDeep : c.fgSecondary }]}>{t('tags.all')}</Text>
      </Touchable>
      {tags.map((tag) => {
        const color = tag.color || DEFAULT_TAG_COLOR;
        const active = tag.id === activeId;
        return (
          <Touchable
            key={tag.id}
            haptic="selection"
            onPress={() => onChange(active ? null : tag.id)}
            style={[
              styles.pill,
              active ? { backgroundColor: withAlpha(color, '20'), borderColor: withAlpha(color, '60') } : styles.inactive,
            ]}
          >
            <View style={[styles.dot, { backgroundColor: color }]} />
            <Text numberOfLines={1} style={[styles.label, { color: active ? color : c.fgSecondary }]}>
              {tag.name}
            </Text>
          </Touchable>
        );
      })}
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  allActive: { backgroundColor: c.accentTint, borderColor: c.accentBorder },
  inactive: { backgroundColor: 'transparent', borderColor: c.hairline },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  label: { fontSize: font.small, fontWeight: '600', maxWidth: 100 },
}));
