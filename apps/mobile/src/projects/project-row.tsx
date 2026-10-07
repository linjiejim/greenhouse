/**
 * ProjectRow — one project in the projects list, drawn in iOS inset-grouped
 * geometry (Reminders "My Lists"): a squircle tile in the project's color, the
 * name (+ lock when private), a meta line (status in its system color · tasks
 * done/total · end date, red when overdue) and a progress ring on the
 * trailing edge.
 *
 * Rows live in a FlatList, so the group card is assembled per row: `first` /
 * `last` round the outer corners and drop the trailing separator. Long-press
 * gives the system context menu (`menu`), tap opens the project.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Project } from '../shared/greenhouse-types';
import { useT } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon } from '../ui/core';
import { IconTile } from '../ui/list';
import { NativeMenu, type MenuItem } from '../ui/menu';
import { formatDay, projectColor, projectStatusColor, projectStatusLabel, todayStamp, toStamp } from './meta';
import { ProgressRing } from './progress';

const TILE = 32;

export function ProjectRow({
  project,
  first,
  last,
  onPress,
  menu,
  onMenu,
}: {
  project: Project;
  first: boolean;
  last: boolean;
  onPress: () => void;
  menu: MenuItem[];
  onMenu: (id: string) => void;
}) {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const color = projectColor(project.color, hex);
  const stats = project.stats;
  const end = toStamp(project.end_date);
  const late = !!end && end < todayStamp() && project.status !== 'completed' && project.status !== 'archived';

  return (
    <NativeMenu trigger="longPress" items={menu} onSelect={onMenu} style={styles.slot}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${project.title}, ${projectStatusLabel(project.status, t)}`}
        style={({ pressed }) => [
          styles.row,
          first && styles.first,
          last && styles.last,
          pressed && { backgroundColor: c.fill },
        ]}
      >
        <IconTile icon={project.status === 'archived' ? 'archive' : 'folder'} tint={color} size={TILE} />
        <View style={styles.texts}>
          <View style={styles.titleLine}>
            <Text numberOfLines={1} style={styles.title}>
              {project.title}
            </Text>
            {project.visibility === 'private' ? <Icon name="lock" size={12} color={c.tertiaryLabel} /> : null}
          </View>
          <View style={styles.metaLine}>
            <Text style={[styles.meta, { color: projectStatusColor(project.status, c), fontWeight: weight.medium }]}>
              {projectStatusLabel(project.status, t)}
            </Text>
            {stats && stats.total > 0 ? (
              <Text style={styles.meta}>· {t('projects.taskCount', { done: stats.done, total: stats.total })}</Text>
            ) : null}
            {end ? (
              <Text style={[styles.meta, late && { color: c.red }]} numberOfLines={1}>
                · {formatDay(end, lang)}
              </Text>
            ) : null}
          </View>
        </View>
        <ProgressRing pct={project.progress ?? 0} color={color} />
        {!last ? <View pointerEvents="none" style={styles.sep} /> : null}
      </Pressable>
    </NativeMenu>
  );
}

const useStyles = makeStyles((c) => ({
  slot: { marginHorizontal: space.margin },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: HIT + 16,
    paddingLeft: space.margin,
    paddingRight: space.md + 2,
    paddingVertical: space.sm + 2,
    backgroundColor: c.secondaryGroupedBackground,
  },
  first: { borderTopLeftRadius: radius.group, borderTopRightRadius: radius.group, ...squircle },
  last: { borderBottomLeftRadius: radius.group, borderBottomRightRadius: radius.group, ...squircle },
  texts: { flex: 1, minWidth: 0, gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 1 },
  title: { ...typo.body, fontWeight: weight.semibold, color: c.label, flexShrink: 1 },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  meta: { ...typo.footnote, color: c.secondaryLabel },
  sep: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: space.margin + TILE + space.md,
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.separator,
  },
}));
