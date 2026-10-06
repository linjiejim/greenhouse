/**
 * GanttChart — mobile-native gantt (single-project and global modes).
 *
 * Semantics mirror the web gantt (apps/web/src/components/project/gantt-*):
 * -7/+14d padded range, day/week/month/year zoom tiers, weekend shading,
 * today line, milestone diamonds, overdue + progress bars, expand/collapse.
 * Rendering is rebuilt for touch: a fixed time-axis row on top (outside the
 * vertical scroll — RN's sticky-header wrapper would swallow a row layout), a
 * fixed label column, one shared vertical scroll, a horizontally pannable
 * canvas whose axis is scroll-synced on the UI thread (`useAnimatedReaction` +
 * `scrollTo`), pinch-to-zoom (live scaleX preview anchored at the focal point
 * → committed re-layout on release) and a native segmented control with the
 * zoom presets as the discoverable fallback. It opens on today, or — when
 * nothing is scheduled around today — on the stretch with the most bars.
 * `bottomInset` keeps the last rows clear of bottom chrome (home indicator,
 * the projects hub's bottom search field).
 *
 * Colors: the canvas is drawn with real strings (`hex.*` system colors, alpha
 * via the theme's `alpha()`) — bars tint by status, red when overdue, project bands in the
 * project's own color. Labels use the dynamic `colors.*`.
 *
 * Context menus (single-project mode): long-press a row's label for the task
 * menu (status / edit / subtask / milestone / delete); tap a label or bar to
 * open the task. Bars stay plain touch targets inside the pinch canvas.
 * Parents start expanded; new parents expand as they appear, manual collapses
 * survive refetches (same rule as the list view). VoiceOver: label cells
 * expose open + expand/collapse as accessibility actions.
 *
 * Deliberately not ported from web: drag move/resize/create, dependency
 * arrows, batch selection, minimap — poor fits for touch; edits go through
 * the task form sheet instead.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
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
import { translate, useT } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import { alpha, makeStyles, radius, space, typo, useTheme, weight, type HexPalette } from '../theme';
import { Icon } from '../ui/core';
import { EmptyState } from '../ui/empty';
import { NativeMenu, type MenuItem } from '../ui/menu';
import { Segmented } from '../ui/segmented';
import { selectionTick } from '../ui/haptics';
import { ProgressBar } from './progress';
import {
  collectParentIds,
  dayIndex,
  forEachTask,
  isMilestone,
  isOverdue,
  projectColor,
  subtreeProgress,
  taskStatusColor,
  taskStatusTint,
  todayIndex,
} from './meta';

// ─── Layout constants ────────────────────────────────────

const LABEL_W = 136;
const ROW_H = 38;
const HEADER_H = 36;
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

/** Per-task context menu (single-project mode). */
export interface GanttTaskMenu {
  items: (task: ProjectTask) => MenuItem[];
  onSelect: (task: ProjectTask, id: string) => void;
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
  onOpenProject,
  taskMenu,
  bottomInset = 0,
}: {
  sections: GanttSection[];
  onOpenTask?: (task: ProjectTask) => void;
  onOpenProject?: (projectId: number) => void;
  taskMenu?: GanttTaskMenu;
  /** Extra space under the last row (bottom chrome the chart sits behind). */
  bottomInset?: number;
}) {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();

  const allTasks = useMemo(() => sections.flatMap((s) => s.tasks), [sections]);
  const [dayWidth, setDayWidth] = useState<number>(ZOOM_DW.week);
  const [expanded, setExpanded] = useState<Set<number>>(() => collectParentIds(allTasks));
  const [foldedProjects, setFoldedProjects] = useState<Set<number>>(new Set());
  const [bodyW, setBodyW] = useState(0);

  // Expand parents as they appear (web parity) but keep manual collapses —
  // keyed on the parent ids, not the array identity (refetches rebuild it).
  const parentKey = useMemo(() => [...collectParentIds(allTasks)].join(','), [allTasks]);
  const seenParents = useRef(parentKey);
  useEffect(() => {
    if (seenParents.current === parentKey) return;
    const before = new Set(seenParents.current.split(','));
    seenParents.current = parentKey;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of parentKey.split(',')) if (id && !before.has(id)) next.add(Number(id));
      return next;
    });
  }, [parentKey]);

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

  // Every drawable span (project bands + task bars), in day indices.
  const spans = useMemo(() => {
    const out: Array<{ start: number; end: number }> = [];
    for (const section of sections) {
      const ps = dayIndex(section.project?.start_date) ?? dayIndex(section.project?.end_date);
      const pe = dayIndex(section.project?.end_date) ?? ps;
      if (ps !== null && pe !== null) out.push({ start: ps, end: pe });
      forEachTask(section.tasks, (task) => {
        const span = taskSpan(task);
        if (span.start !== null && span.end !== null) out.push({ start: span.start, end: span.end });
      });
    }
    return out;
  }, [sections]);
  const hasAnyBar = spans.length > 0;

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
  const lang = usePrefs((st) => st.lang);
  const months = useMemo(() => translate(lang, 'date.months').split(','), [lang]);
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

  const commitZoom = useCallback((scale: number, focalX: number, sx: number) => {
    setDayWidth((prev) => {
      const next = Math.min(MAX_DW, Math.max(MIN_DW, prev * scale));
      if (next !== prev) pendingScroll.current = Math.max(0, (sx + focalX) * (next / prev) - focalX);
      if (tierOf(next) !== tierOf(prev)) selectionTick();
      return next;
    });
  }, []);

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

  // First layout: land on today — unless nothing is scheduled around today
  // (e.g. a project that ended last quarter): then open on the stretch that
  // shows the most bars (ties → the one nearest today).
  const didInitScroll = useRef(false);
  useEffect(() => {
    if (didInitScroll.current || bodyW === 0) return;
    didInitScroll.current = true;
    const todayLeft = Math.max(0, todayX - bodyW * 0.4);
    let x = todayLeft;
    const visibleDays = bodyW / dayWidth;
    const countIn = (left: number) =>
      spans.reduce((n, sp) => (sp.end + 1 > left && sp.start < left + visibleDays ? n + 1 : n), 0);
    if (spans.length > 0 && countIn(range.startIndex + todayLeft / dayWidth) === 0) {
      const today = todayIndex();
      let best = { left: 0, count: -1 };
      for (const sp of spans) {
        const left = sp.start - 1;
        const count = countIn(left);
        if (count > best.count || (count === best.count && Math.abs(left - today) < Math.abs(best.left - today))) {
          best = { left, count };
        }
      }
      x = (best.left - range.startIndex) * dayWidth;
    }
    bodyRef.current?.scrollTo({ x: Math.max(0, Math.min(x, totalW - bodyW)), animated: false });
  }, [bodyW, todayX, bodyRef, spans, range.startIndex, dayWidth, totalW]);

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
    if (sections.some((s) => s.project)) {
      // global mode: fold / unfold the project bands
      setFoldedProjects((prev) => (prev.size > 0 ? new Set() : new Set(sections.flatMap((s) => (s.project ? [s.project.id] : [])))));
    } else {
      setExpanded((prev) => (prev.size > 0 ? new Set() : collectParentIds(allTasks)));
    }
  }, [sections, allTasks]);

  const onBodyLayout = useCallback((e: LayoutChangeEvent) => {
    setBodyW(e.nativeEvent.layout.width);
  }, []);

  if (!hasAnyBar && rows.length === 0) {
    return <EmptyState icon="gantt" title={t('projects.noTasks')} message={t('projects.noTasksHint')} />;
  }

  return (
    <View style={styles.root}>
      {/* control bar: zoom presets + today + fold-all */}
      <View style={styles.controls}>
        <Segmented<Zoom>
          style={{ flex: 1 }}
          options={[
            { value: 'day', label: t('projects.zoom_day') },
            { value: 'week', label: t('projects.zoom_week') },
            { value: 'month', label: t('projects.zoom_month') },
            { value: 'year', label: t('projects.zoom_year') },
          ]}
          value={tier}
          onChange={setPresetZoom}
        />
        <Pressable
          onPress={scrollToToday}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('projects.today')}
          style={({ pressed }) => [styles.controlBtn, pressed && { opacity: 0.5 }]}
        >
          <Text style={styles.controlBtnText}>{t('projects.today')}</Text>
        </Pressable>
        <Pressable
          onPress={toggleFoldAll}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('projects.foldAll')}
          style={({ pressed }) => [styles.controlIcon, pressed && { opacity: 0.5 }]}
        >
          <Icon name="foldAll" size={17} weight="medium" color={c.accent} />
        </Pressable>
      </View>

      {!hasAnyBar ? (
        <EmptyState icon="gantt" title={t('projects.ganttEmpty')} message={t('projects.ganttHint')} />
      ) : (
        <>
          {/* time axis — a fixed row above the vertical scroll, synced to the canvas */}
          <View style={styles.headerRow}>
            <View style={[styles.cornerCell, { width: LABEL_W }]}>
              <Text style={styles.cornerText} numberOfLines={1}>
                {t('projects.taskColumn')}
              </Text>
            </View>
            <View style={styles.headerTrack} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
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
                  <View style={[styles.todayDot, { left: todayX + dayWidth / 2 - 3, backgroundColor: hex.red }]} />
                </Animated.View>
              </Animated.ScrollView>
            </View>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: bottomInset }}
          >
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
                      menu={taskMenu}
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
                          style={[styles.gridLine, { left: g.x, height: canvasH }, g.strong && { backgroundColor: c.opaqueSeparator }]}
                        />
                      ))}
                      {/* row separators */}
                      {rows.map((row, i) => (
                        <View key={`s${row.key}`} style={[styles.rowSep, { top: (i + 1) * ROW_H - 1, width: totalW }]} />
                      ))}
                      {/* today line */}
                      <View style={[styles.todayLine, { left: todayX + dayWidth / 2, height: canvasH, backgroundColor: hex.red }]} />
                      {/* bars */}
                      {rows.map((row, i) =>
                        row.kind === 'project' ? (
                          <ProjectBar key={`b${row.key}`} row={row} rowIndex={i} startIndex={range.startIndex} dayWidth={dayWidth} hex={hex} />
                        ) : (
                          <TaskBar
                            key={`b${row.key}`}
                            task={row.task}
                            rowIndex={i}
                            startIndex={range.startIndex}
                            dayWidth={dayWidth}
                            hex={hex}
                            onPress={onOpenTask ? () => onOpenTask(row.task) : undefined}
                          />
                        ),
                      )}
                    </Animated.View>
                  </Animated.ScrollView>
                </GestureDetector>
              </View>
            </View>
          </ScrollView>
        </>
      )}
    </View>
  );
}

// ─── Label cells ─────────────────────────────────────────

/** VoiceOver: open + expand/collapse as actions on the (single) label element. */
function useCellA11y(onOpen: (() => void) | undefined, toggle: { expanded: boolean; onToggle: () => void } | null) {
  const t = useT();
  const actions = [
    ...(onOpen ? [{ name: 'activate' }] : []),
    ...(toggle ? [{ name: 'toggle', label: toggle.expanded ? t('projects.collapse') : t('projects.expand') }] : []),
  ];
  return {
    accessibilityActions: actions,
    accessibilityState: toggle ? { expanded: toggle.expanded } : undefined,
    onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
      if (e.nativeEvent.actionName === 'activate') (onOpen ?? toggle?.onToggle)?.();
      else if (e.nativeEvent.actionName === 'toggle') toggle?.onToggle();
    },
  };
}

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
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const a11y = useCellA11y(onOpen ?? onToggle, { expanded: !folded, onToggle });
  return (
    <Pressable
      onPress={onOpen ?? onToggle}
      accessibilityRole="button"
      accessibilityLabel={row.project.title}
      {...a11y}
      style={({ pressed }) => [styles.labelCell, styles.projectCell, pressed && { backgroundColor: c.fill }]}
    >
      <Pressable
        onPress={onToggle}
        hitSlop={8}
        style={styles.chevBox}
        accessibilityRole="button"
        accessibilityLabel={folded ? t('projects.expand') : t('projects.collapse')}
      >
        <Icon name={folded ? 'chevR' : 'chevD'} size={12} weight="semibold" color={c.tertiaryLabel} />
      </Pressable>
      <View style={[styles.projectDot, { backgroundColor: projectColor(row.project.color, hex) }]} />
      <Text numberOfLines={1} style={styles.projectLabelText}>
        {row.project.title}
      </Text>
    </Pressable>
  );
}

function TaskLabelCell({
  row,
  isExpanded,
  onToggle,
  onOpen,
  menu,
}: {
  row: Extract<Row, { kind: 'task' }>;
  isExpanded: boolean;
  onToggle: () => void;
  onOpen?: () => void;
  menu?: GanttTaskMenu;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const task = row.task;
  const done = task.status === 'done' || task.status === 'cancelled';
  const overdue = isOverdue(task);
  const a11y = useCellA11y(onOpen, row.isParent ? { expanded: isExpanded, onToggle } : null);
  const cell = (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={overdue ? `${task.title}, ${t('projects.overdue')}` : task.title}
      {...a11y}
      style={({ pressed }) => [styles.labelCell, { paddingLeft: space.xs + row.depth * 12 }, pressed && { backgroundColor: c.fill }]}
    >
      {row.isParent ? (
        <Pressable
          onPress={onToggle}
          hitSlop={8}
          style={styles.chevBox}
          accessibilityRole="button"
          accessibilityLabel={isExpanded ? t('projects.collapse') : t('projects.expand')}
        >
          <Icon name={isExpanded ? 'chevD' : 'chevR'} size={12} weight="semibold" color={c.tertiaryLabel} />
        </Pressable>
      ) : (
        <View style={styles.chevBox} />
      )}
      {isMilestone(task) ? <Icon name="diamondFill" size={10} color={c.orange} /> : null}
      <Text numberOfLines={1} style={[styles.labelText, done && styles.labelDone, overdue && { color: c.red }]}>
        {task.title}
      </Text>
    </Pressable>
  );
  if (!menu) return cell;
  // Long-press menus fill their slot (measured, then pinned) — without that
  // the SwiftUI host sizes the trigger to the text's intrinsic width and long
  // titles paint across the canvas instead of truncating.
  return (
    <NativeMenu trigger="longPress" style={styles.labelSlot} items={menu.items(task)} onSelect={(id) => menu.onSelect(task, id)}>
      {cell}
    </NativeMenu>
  );
}

// ─── Bars ────────────────────────────────────────────────

function ProjectBar({
  row,
  rowIndex,
  startIndex,
  dayWidth,
  hex,
}: {
  row: Extract<Row, { kind: 'project' }>;
  rowIndex: number;
  startIndex: number;
  dayWidth: number;
  hex: HexPalette;
}) {
  if (row.start === null || row.end === null) return null;
  const left = (row.start - startIndex) * dayWidth;
  const width = Math.max((row.end - row.start + 1) * dayWidth, dayWidth);
  const color = projectColor(row.project.color, hex);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: rowIndex * ROW_H + (ROW_H - 8) / 2, left, width }}>
      <ProgressBar pct={row.project.progress ?? 0} color={color} track={alpha(color, 0.25)} height={8} />
    </View>
  );
}

function TaskBar({
  task,
  rowIndex,
  startIndex,
  dayWidth,
  hex,
  onPress,
}: {
  task: ProjectTask;
  rowIndex: number;
  startIndex: number;
  dayWidth: number;
  hex: HexPalette;
  onPress?: () => void;
}) {
  const span = taskSpan(task);
  if (span.start === null || span.end === null) return null;
  const top = rowIndex * ROW_H;
  const left = (span.start - startIndex) * dayWidth;

  if (isMilestone(task)) {
    const size = 13;
    return (
      <Pressable
        onPress={onPress}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={task.title}
        style={{
          position: 'absolute',
          top: top + (ROW_H - size) / 2,
          left: left + dayWidth / 2 - size / 2,
          width: size,
          height: size,
          backgroundColor: task.status === 'done' ? hex.green : hex.orange,
          borderRadius: 3,
          transform: [{ rotate: '45deg' }],
        }}
      />
    );
  }

  const overdue = isOverdue(task);
  const tone = overdue ? hex.red : taskStatusColor(task.status, hex);
  const tint = overdue ? hex.redFill : taskStatusTint(task.status, hex);
  const width = Math.max((span.end - span.start + 1) * dayWidth, Math.max(dayWidth, 6));
  const progress = subtreeProgress(task);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={task.title}
      style={({ pressed }) => ({
        position: 'absolute',
        top: top + (ROW_H - BAR_H) / 2,
        left,
        width,
        height: BAR_H,
        borderRadius: radius.xs,
        borderCurve: 'continuous',
        backgroundColor: tint,
        borderWidth: 1,
        borderColor: alpha(tone, 0.55),
        overflow: 'hidden',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ width: `${progress}%`, flex: 1, backgroundColor: alpha(tone, 0.75) }} />
    </Pressable>
  );
}

// ─── Styles ──────────────────────────────────────────────

const useStyles = makeStyles((c) => ({
  root: { flex: 1 },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.margin,
    paddingBottom: space.sm,
  },
  controlBtn: { height: 32, justifyContent: 'center' },
  controlBtnText: { ...typo.subheadline, fontWeight: weight.semibold, color: c.accent },
  controlIcon: { width: 28, height: 32, alignItems: 'center', justifyContent: 'center' },

  headerRow: {
    flexDirection: 'row',
    backgroundColor: c.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.separator,
  },
  headerTrack: { flex: 1, overflow: 'hidden' },
  labelSlot: { width: LABEL_W, overflow: 'hidden' },
  cornerCell: { height: HEADER_H, justifyContent: 'center', paddingLeft: space.margin },
  cornerText: { ...typo.footnote, fontWeight: weight.semibold, color: c.secondaryLabel },
  tickLabel: { position: 'absolute', top: 9, ...typo.caption1, color: c.tertiaryLabel },
  tickLabelStrong: { color: c.secondaryLabel, fontWeight: weight.semibold },
  todayDot: { position: 'absolute', bottom: 3, width: 6, height: 6, borderRadius: 3 },

  labelCell: {
    height: ROW_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingRight: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.separator,
    backgroundColor: c.background,
  },
  projectCell: { backgroundColor: c.secondaryBackground, paddingLeft: space.xs },
  chevBox: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  projectDot: { width: 8, height: 8, borderRadius: 4, marginRight: 2 },
  projectLabelText: { flex: 1, ...typo.footnote, fontWeight: weight.semibold, color: c.label },
  labelText: { flex: 1, ...typo.footnote, color: c.label },
  labelDone: { textDecorationLine: 'line-through', color: c.tertiaryLabel },

  weekendCol: { position: 'absolute', top: 0, backgroundColor: c.quaternaryFill },
  gridLine: { position: 'absolute', top: 0, width: StyleSheet.hairlineWidth, backgroundColor: c.separator },
  rowSep: { position: 'absolute', left: 0, height: StyleSheet.hairlineWidth, backgroundColor: c.separator, opacity: 0.6 },
  todayLine: { position: 'absolute', top: 0, width: 1.5, opacity: 0.85 },
}));
