/**
 * GanttChart — mobile-native gantt (single-project and global modes).
 *
 * Semantics mirror the web gantt (apps/web/src/components/project/gantt-*):
 * -7/+14d padded range, day/week/month/year zoom tiers, weekend shading,
 * today line, milestone diamonds, overdue + progress bars, expand/collapse.
 * Rendering is rebuilt for touch: a fixed label column, one shared vertical
 * scroll, a horizontally pannable canvas whose header is scroll-synced on the
 * UI thread, pinch-to-zoom (live scaleX preview → committed re-layout on
 * release) and Segmented zoom presets as the discoverable fallback.
 *
 * Deliberately not ported from web: drag move/resize/create, dependency
 * arrows, batch selection, minimap — poor fits for touch; edits go through
 * the task sheet instead.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import type { ProjectTask } from '../shared/greenhouse-types';
import { useT } from '../lib/i18n';
import { EmptyState, Icon, Segmented, Touchable } from '../ui';
import { font, makeStyles, radius, useTheme, weight, type ThemeColors } from '../theme';
import {
  collectParentIds,
  dayIndex,
  forEachTask,
  hexAlpha,
  isOverdue,
  subtreeProgress,
  taskStatusColor,
  taskStatusTint,
  todayIndex,
} from './meta';

// ─── Layout constants ────────────────────────────────────

const LABEL_W = 132;
const ROW_H = 36;
const HEADER_H = 40;
const BAR_H = 18;
const MIN_DW = 3;
const MAX_DW = 48;

type Zoom = 'day' | 'week' | 'month' | 'year';
/** Preset day-widths, mirroring web's ganttDayWidth(). */
const ZOOM_DW: Record<Zoom, number> = { day: 28, week: 14, month: 8, year: 3 };

function tierOf(dw: number): Zoom {
  if (dw >= 18) return 'day';
  if (dw >= 9) return 'week';
  if (dw >= 4.5) return 'month';
  return 'year';
}

/** Day-of-week for a UTC day index (0 = Sunday; epoch day 0 was a Thursday). */
function dowOf(index: number): number {
  return (((index + 4) % 7) + 7) % 7;
}

// ─── Row model ───────────────────────────────────────────

export interface GanttSectionProject {
  id: number;
  title: string;
  color: string | null;
  start_date?: string | null;
  end_date?: string | null;
  progress?: number;
}

export interface GanttSection {
  /** Present in global mode — renders a collapsible project band row. */
  project?: GanttSectionProject;
  tasks: ProjectTask[];
}

type Row =
  | { kind: 'project'; key: string; project: GanttSectionProject; start: number | null; end: number | null }
  | { kind: 'task'; key: string; task: ProjectTask; depth: number; isParent: boolean };

function taskSpan(task: ProjectTask): { start: number | null; end: number | null } {
  const s = dayIndex(task.start_date) ?? dayIndex(task.due_date);
  const e = dayIndex(task.due_date) ?? dayIndex(task.start_date);
  return { start: s, end: e };
}

// ─── Component ───────────────────────────────────────────

export function GanttChart({
  sections,
  onOpenTask,
  onLongPressTask,
  onOpenProject,
}: {
  sections: GanttSection[];
  onOpenTask?: (task: ProjectTask) => void;
  onLongPressTask?: (task: ProjectTask) => void;
  onOpenProject?: (projectId: number) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();

  const [dayWidth, setDayWidth] = useState<number>(ZOOM_DW.week);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [foldedProjects, setFoldedProjects] = useState<Set<number>>(new Set());
  const [bodyW, setBodyW] = useState(0);

  // Auto-expand every parent when the data set changes (web parity).
  const allTasks = useMemo(() => sections.flatMap((s) => s.tasks), [sections]);
  useEffect(() => {
    setExpanded(collectParentIds(allTasks));
  }, [allTasks]);

  // ── Date range (web computeGanttRange parity: pad −7/+14, ≥30 days) ──
  const range = useMemo(() => {
    const days: number[] = [todayIndex()];
    for (const section of sections) {
      const p = section.project;
      for (const d of [p?.start_date, p?.end_date]) {
        const idx = dayIndex(d);
        if (idx !== null) days.push(idx);
      }
      forEachTask(section.tasks, (task) => {
        for (const d of [task.start_date, task.due_date]) {
          const idx = dayIndex(d);
          if (idx !== null) days.push(idx);
        }
      });
    }
    const startIndex = Math.min(...days) - 7;
    const totalDays = Math.max(Math.max(...days) + 14 - startIndex, 30);
    return { startIndex, totalDays };
  }, [sections]);

  const hasAnyBar = useMemo(() => {
    let found = false;
    for (const section of sections) {
      if (section.project?.start_date || section.project?.end_date) found = true;
      forEachTask(section.tasks, (task) => {
        if (task.start_date || task.due_date) found = true;
      });
    }
    return found;
  }, [sections]);

  // ── Row model (expand/collapse applied) ─────────────────
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const section of sections) {
      if (section.project) {
        const p = section.project;
        // Project band spans its explicit dates, else its tasks' extent.
        let s = dayIndex(p.start_date);
        let e = dayIndex(p.end_date);
        if (s === null || e === null) {
          forEachTask(section.tasks, (task) => {
            const span = taskSpan(task);
            if (span.start !== null) s = s === null ? span.start : Math.min(s, span.start);
            if (span.end !== null) e = e === null ? span.end : Math.max(e, span.end);
          });
        }
        out.push({ kind: 'project', key: `p${p.id}`, project: p, start: s, end: e });
        if (foldedProjects.has(p.id)) continue;
      }
      const walk = (nodes: ProjectTask[], depth: number) => {
        for (const task of nodes) {
          const isParent = !!task.children && task.children.length > 0;
          out.push({ kind: 'task', key: `t${task.id}`, task, depth, isParent });
          if (isParent && expanded.has(task.id)) walk(task.children!, depth + 1);
        }
      };
      walk(section.tasks, 0);
    }
    return out;
  }, [sections, expanded, foldedProjects]);

  const totalW = Math.max(range.totalDays * dayWidth, bodyW);
  const canvasH = rows.length * ROW_H;
  const todayX = (todayIndex() - range.startIndex) * dayWidth;
  const tier = tierOf(dayWidth);

  // ── Ticks + grid (committed layout; recomputed on zoom commit only) ──
  const months = useMemo(() => t('date.months').split(','), [t]);
  const ticks = useMemo(() => {
    const labels: Array<{ x: number; label: string; strong?: boolean }> = [];
    const grid: Array<{ x: number; strong?: boolean }> = [];
    const weekends: number[] = [];
    for (let i = 0; i < range.totalDays; i++) {
      const idx = range.startIndex + i;
      const date = new Date(idx * 86400000);
      const dom = date.getUTCDate();
      const month = date.getUTCMonth();
      const dow = dowOf(idx);
      const x = i * dayWidth;
      if (tier === 'day') {
        grid.push({ x, strong: dom === 1 });
        if (dow === 0 || dow === 6) weekends.push(x);
        labels.push({
          x,
          label: dom === 1 || i === 0 ? `${months[month]}${dom > 1 ? ` ${dom}` : ''}` : String(dom),
          strong: dom === 1,
        });
      } else if (tier === 'week') {
        if (dom === 1) grid.push({ x, strong: true });
        if (dow === 0 || dow === 6) weekends.push(x);
        if (dow === 1) {
          grid.push({ x });
          labels.push({ x, label: `${date.getUTCMonth() + 1}/${dom}`, strong: dom <= 7 });
        }
      } else if (dom === 1) {
        grid.push({ x, strong: month === 0 });
        if (tier === 'month' || month % 3 === 0) {
          labels.push({
            x,
            label: month === 0 ? `${date.getUTCFullYear()} ${months[0]}` : months[month],
            strong: month === 0,
          });
        }
      }
    }
    return { labels, grid, weekends };
  }, [range, dayWidth, tier, months]);

  // ── Horizontal sync + pinch zoom ────────────────────────
  const scrollX = useSharedValue(0);
  const headerRef = useAnimatedRef<Animated.ScrollView>();
  const bodyRef = useAnimatedRef<Animated.ScrollView>();
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollX.value = e.contentOffset.x;
  });
  useAnimatedReaction(
    () => scrollX.value,
    (x) => {
      scrollTo(headerRef, x, 0, false);
    },
  );

  const pinchScale = useSharedValue(1);
  const pinchFocalX = useSharedValue(0);
  const pinchActive = useSharedValue(false);
  const pendingScroll = useRef<number | null>(null);

  const commitZoom = useCallback(
    (scale: number, focalX: number, sx: number) => {
      setDayWidth((prev) => {
        const next = Math.min(MAX_DW, Math.max(MIN_DW, prev * scale));
        if (next !== prev) pendingScroll.current = Math.max(0, (sx + focalX) * (next / prev) - focalX);
        return next;
      });
    },
    [],
  );

  // Preset switch keeps the date under the viewport center stable.
  const setPresetZoom = useCallback(
    (z: Zoom) => {
      setDayWidth((prev) => {
        const next = ZOOM_DW[z];
        if (next !== prev) {
          const center = scrollX.value + bodyW / 2;
          pendingScroll.current = Math.max(0, center * (next / prev) - bodyW / 2);
        }
        return next;
      });
    },
    [scrollX, bodyW],
  );

  // Re-anchor the viewport after a zoom commit re-layouts the canvas.
  useEffect(() => {
    if (pendingScroll.current === null) return;
    const x = pendingScroll.current;
    pendingScroll.current = null;
    bodyRef.current?.scrollTo({ x, animated: false });
  }, [dayWidth, bodyRef]);

  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .onStart((e) => {
          pinchActive.value = true;
          pinchScale.value = 1;
          pinchFocalX.value = e.focalX;
        })
        .onUpdate((e) => {
          pinchScale.value = e.scale;
        })
        .onEnd(() => {
          pinchActive.value = false;
          runOnJS(commitZoom)(pinchScale.value, pinchFocalX.value, scrollX.value);
        }),
    [commitZoom, pinchActive, pinchScale, pinchFocalX, scrollX],
  );

  // Live preview: scale the canvas around the pinch focal point; the commit
  // re-layouts at the new day width and resets this to identity.
  const previewStyle = useAnimatedStyle(() => {
    if (!pinchActive.value) return { transform: [{ translateX: 0 }, { scaleX: 1 }] };
    const s = pinchScale.value;
    const anchor = scrollX.value + pinchFocalX.value;
    return { transform: [{ translateX: (anchor - totalW / 2) * (1 - s) }, { scaleX: s }] };
  }, [totalW]);

  const scrollToToday = useCallback(() => {
    bodyRef.current?.scrollTo({ x: Math.max(0, todayX - bodyW * 0.4), animated: true });
  }, [bodyRef, todayX, bodyW]);

  // First layout: land on today.
  const didInitScroll = useRef(false);
  useEffect(() => {
    if (didInitScroll.current || bodyW === 0) return;
    didInitScroll.current = true;
    bodyRef.current?.scrollTo({ x: Math.max(0, todayX - bodyW * 0.4), animated: false });
  }, [bodyW, todayX, bodyRef]);

  const toggleTask = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleProject = useCallback((id: number) => {
    setFoldedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleFoldAll = useCallback(() => {
    setExpanded((prev) => (prev.size > 0 ? new Set() : collectParentIds(allTasks)));
  }, [allTasks]);

  const onBodyLayout = useCallback((e: LayoutChangeEvent) => {
    setBodyW(e.nativeEvent.layout.width);
  }, []);

  if (!hasAnyBar && rows.length === 0) {
    return <EmptyState icon="gantt" title={t('projects.noTasks')} sub={t('projects.noTasksHint')} />;
  }

  return (
    <View style={styles.root}>
      {/* control bar: zoom presets + today + fold-all */}
      <View style={styles.controls}>
        <Segmented<Zoom>
          style={{ flex: 1 }}
          items={[
            { id: 'day', label: t('projects.zoom_day') },
            { id: 'week', label: t('projects.zoom_week') },
            { id: 'month', label: t('projects.zoom_month') },
            { id: 'year', label: t('projects.zoom_year') },
          ]}
          value={tier}
          onChange={setPresetZoom}
        />
        <Touchable haptic="selection" onPress={scrollToToday} style={styles.controlBtn} accessibilityLabel={t('projects.today')}>
          <Text style={styles.controlBtnText}>{t('projects.today')}</Text>
        </Touchable>
        <Touchable haptic="selection" onPress={toggleFoldAll} style={styles.controlIconBtn} accessibilityLabel={t('projects.foldAll')}>
          <Icon name="foldAll" size={16} color={c.fgSecondary} />
        </Touchable>
      </View>

      {!hasAnyBar ? (
        <EmptyState icon="gantt" title={t('projects.ganttEmpty')} sub={t('projects.ganttHint')} />
      ) : (
        <ScrollView stickyHeaderIndices={[0]} bounces={false} showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
          {/* [0] sticky time-axis header */}
          <View style={styles.headerRow}>
            <View style={[styles.cornerCell, { width: LABEL_W }]}>
              <Text style={styles.cornerText} numberOfLines={1}>
                {t('projects.taskColumn')}
              </Text>
            </View>
            <View style={{ flex: 1, overflow: 'hidden' }}>
              <Animated.ScrollView ref={headerRef} horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false}>
                <Animated.View style={[{ width: totalW, height: HEADER_H }, previewStyle]}>
                  {ticks.labels.map((tick, i) => (
                    <Text
                      key={i}
                      numberOfLines={1}
                      style={[styles.tickLabel, { left: tick.x + 3 }, tick.strong && styles.tickLabelStrong]}
                    >
                      {tick.label}
                    </Text>
                  ))}
                  <View style={[styles.todayDot, { left: todayX + dayWidth / 2 - 3 }]} />
                </Animated.View>
              </Animated.ScrollView>
            </View>
          </View>

          {/* body: fixed labels + pannable canvas */}
          <View style={{ flexDirection: 'row' }}>
            <View style={{ width: LABEL_W }}>
              {rows.map((row) =>
                row.kind === 'project' ? (
                  <ProjectLabelCell
                    key={row.key}
                    row={row}
                    folded={foldedProjects.has(row.project.id)}
                    onToggle={() => toggleProject(row.project.id)}
                    onOpen={onOpenProject ? () => onOpenProject(row.project.id) : undefined}
                  />
                ) : (
                  <TaskLabelCell
                    key={row.key}
                    row={row}
                    isExpanded={expanded.has(row.task.id)}
                    onToggle={() => toggleTask(row.task.id)}
                    onOpen={onOpenTask ? () => onOpenTask(row.task) : undefined}
                    onLongPress={onLongPressTask ? () => onLongPressTask(row.task) : undefined}
                  />
                ),
              )}
            </View>

            <View style={{ flex: 1 }} onLayout={onBodyLayout}>
              <GestureDetector gesture={pinch}>
                <Animated.ScrollView
                  ref={bodyRef}
                  horizontal
                  bounces={false}
                  onScroll={onScroll}
                  scrollEventThrottle={16}
                  showsHorizontalScrollIndicator={false}
                >
                  <Animated.View style={[{ width: totalW, height: canvasH }, previewStyle]}>
                    {/* weekends */}
                    {ticks.weekends.map((x, i) => (
                      <View key={`w${i}`} style={[styles.weekendCol, { left: x, width: dayWidth, height: canvasH }]} />
                    ))}
                    {/* grid lines */}
                    {ticks.grid.map((g, i) => (
                      <View
                        key={`g${i}`}
                        style={[styles.gridLine, { left: g.x, height: canvasH }, g.strong && { backgroundColor: c.hairlineStrong }]}
                      />
                    ))}
                    {/* row separators */}
                    {rows.map((row, i) => (
                      <View key={`s${row.key}`} style={[styles.rowSep, { top: (i + 1) * ROW_H - 1, width: totalW }]} />
                    ))}
                    {/* today line */}
                    <View style={[styles.todayLine, { left: todayX + dayWidth / 2, height: canvasH }]} />
                    {/* bars */}
                    {rows.map((row, i) =>
                      row.kind === 'project' ? (
                        <ProjectBar key={`b${row.key}`} row={row} rowIndex={i} startIndex={range.startIndex} dayWidth={dayWidth} colors={c} />
                      ) : (
                        <TaskBar
                          key={`b${row.key}`}
                          task={row.task}
                          rowIndex={i}
                          startIndex={range.startIndex}
                          dayWidth={dayWidth}
                          colors={c}
                          onPress={onOpenTask ? () => onOpenTask(row.task) : undefined}
                          onLongPress={onLongPressTask ? () => onLongPressTask(row.task) : undefined}
                        />
                      ),
                    )}
                  </Animated.View>
                </Animated.ScrollView>
              </GestureDetector>
            </View>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

// ─── Label cells ─────────────────────────────────────────

function ProjectLabelCell({
  row,
  folded,
  onToggle,
  onOpen,
}: {
  row: Extract<Row, { kind: 'project' }>;
  folded: boolean;
  onToggle: () => void;
  onOpen?: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Touchable haptic="none" onPress={onOpen ?? onToggle} onLongPress={onToggle} style={[styles.labelCell, styles.projectCell]}>
      <Touchable haptic="selection" onPress={onToggle} hitSlop={8} style={styles.chevBox}>
        <Icon name={folded ? 'chevR' : 'chevD'} size={13} color={c.fgFaint} />
      </Touchable>
      <View style={[styles.projectDot, { backgroundColor: row.project.color ?? c.accent }]} />
      <Text numberOfLines={1} style={styles.projectLabelText}>
        {row.project.title}
      </Text>
    </Touchable>
  );
}

function TaskLabelCell({
  row,
  isExpanded,
  onToggle,
  onOpen,
  onLongPress,
}: {
  row: Extract<Row, { kind: 'task' }>;
  isExpanded: boolean;
  onToggle: () => void;
  onOpen?: () => void;
  onLongPress?: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const task = row.task;
  const isMilestone = task.task_type === 'milestone';
  const done = task.status === 'done';
  return (
    <Touchable haptic="none" onPress={onOpen} onLongPress={onLongPress} style={[styles.labelCell, { paddingLeft: 4 + row.depth * 12 }]}>
      {row.isParent ? (
        <Touchable haptic="selection" onPress={onToggle} hitSlop={8} style={styles.chevBox}>
          <Icon name={isExpanded ? 'chevD' : 'chevR'} size={13} color={c.fgFaint} />
        </Touchable>
      ) : (
        <View style={styles.chevBox} />
      )}
      {isMilestone ? <Icon name="diamond" size={11} color={c.warning} /> : null}
      <Text numberOfLines={1} style={[styles.labelText, done && styles.labelDone, isOverdue(task) && { color: c.danger }]}>
        {task.title}
      </Text>
    </Touchable>
  );
}

// ─── Bars ────────────────────────────────────────────────

function ProjectBar({
  row,
  rowIndex,
  startIndex,
  dayWidth,
  colors: c,
}: {
  row: Extract<Row, { kind: 'project' }>;
  rowIndex: number;
  startIndex: number;
  dayWidth: number;
  colors: ThemeColors;
}) {
  if (row.start === null || row.end === null) return null;
  const left = (row.start - startIndex) * dayWidth;
  const width = Math.max((row.end - row.start + 1) * dayWidth, dayWidth);
  const color = row.project.color ?? c.accent;
  const progress = Math.max(0, Math.min(100, row.project.progress ?? 0));
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: rowIndex * ROW_H + (ROW_H - 8) / 2,
        left,
        width,
        height: 8,
        borderRadius: radius.full,
        backgroundColor: hexAlpha(color, 0.25),
        overflow: 'hidden',
      }}
    >
      <View style={{ width: `${progress}%`, flex: 1, backgroundColor: color, borderRadius: radius.full }} />
    </View>
  );
}

function TaskBar({
  task,
  rowIndex,
  startIndex,
  dayWidth,
  colors: c,
  onPress,
  onLongPress,
}: {
  task: ProjectTask;
  rowIndex: number;
  startIndex: number;
  dayWidth: number;
  colors: ThemeColors;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const span = taskSpan(task);
  if (span.start === null || span.end === null) return null;
  const top = rowIndex * ROW_H;
  const left = (span.start - startIndex) * dayWidth;

  if (task.task_type === 'milestone') {
    const size = 13;
    return (
      <Touchable
        haptic="none"
        onPress={onPress}
        onLongPress={onLongPress}
        hitSlop={10}
        style={{
          position: 'absolute',
          top: top + (ROW_H - size) / 2,
          left: left + dayWidth / 2 - size / 2,
          width: size,
          height: size,
          backgroundColor: c.warning,
          borderRadius: 3,
          transform: [{ rotate: '45deg' }],
        }}
      >
        {null}
      </Touchable>
    );
  }

  const overdue = isOverdue(task);
  const tone = overdue ? c.danger : taskStatusColor(task.status, c);
  const tint = overdue ? c.dangerTint : taskStatusTint(task.status, c);
  const width = Math.max((span.end - span.start + 1) * dayWidth, Math.max(dayWidth, 6));
  const progress = subtreeProgress(task);
  return (
    <Touchable
      haptic="none"
      onPress={onPress}
      onLongPress={onLongPress}
      pressedStyle={{ opacity: 0.7 }}
      style={{
        position: 'absolute',
        top: top + (ROW_H - BAR_H) / 2,
        left,
        width,
        height: BAR_H,
        borderRadius: 5,
        backgroundColor: tint,
        borderWidth: 1,
        borderColor: hexAlpha(tone, 0.55),
        overflow: 'hidden',
      }}
    >
      <View style={{ width: `${progress}%`, flex: 1, backgroundColor: hexAlpha(tone, 0.75) }} />
    </Touchable>
  );
}

// ─── Styles ──────────────────────────────────────────────

const useStyles = makeStyles((c) => ({
  root: { flex: 1 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  controlBtn: {
    paddingHorizontal: 12,
    height: 34,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlBtnText: { fontSize: font.small, fontWeight: weight.semibold, color: c.fgSecondary },
  controlIconBtn: {
    width: 34,
    height: 34,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  headerRow: {
    flexDirection: 'row',
    backgroundColor: c.bg,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
    zIndex: 2,
  },
  cornerCell: { height: HEADER_H, justifyContent: 'center', paddingLeft: 16 },
  cornerText: { fontSize: font.caption, fontWeight: weight.medium, color: c.fgMuted },
  tickLabel: { position: 'absolute', top: 12, fontSize: font.caption, color: c.fgFaint },
  tickLabelStrong: { color: c.fgSecondary, fontWeight: weight.semibold },
  todayDot: { position: 'absolute', bottom: 3, width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent },

  labelCell: {
    height: ROW_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingRight: 6,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  projectCell: { backgroundColor: c.surfaceMuted, paddingLeft: 4 },
  chevBox: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  projectDot: { width: 8, height: 8, borderRadius: 4 },
  projectLabelText: { flex: 1, fontSize: font.small, fontWeight: weight.semibold, color: c.fg },
  labelText: { flex: 1, fontSize: font.small, color: c.fgSecondary },
  labelDone: { textDecorationLine: 'line-through', color: c.fgFaint },

  weekendCol: { position: 'absolute', top: 0, backgroundColor: c.surfaceMuted, opacity: 0.45 },
  gridLine: { position: 'absolute', top: 0, width: 1, backgroundColor: c.hairline, opacity: 0.6 },
  rowSep: { position: 'absolute', left: 0, height: 1, backgroundColor: c.hairline, opacity: 0.5 },
  todayLine: { position: 'absolute', top: 0, width: 1.5, backgroundColor: c.accent, opacity: 0.75 },
}));
