/**
 * Task detail — a grouped-background page in the Reminders "details" idiom
 * (web parity: task-drawer.tsx):
 *
 *  - header: title (title1 — same as knowledge docs; it slides into the
 *    navigation bar once scrolled under it), status / milestone / overdue
 *    pills, project name,
 *  - details: iOS list rows with colored symbol tiles — 状态 / 优先级 / 负责人
 *    are pop-up menus that change the value in place; 开始 / 截止 open the
 *    form; milestone, parent task, estimate, tags, dependencies when present,
 *  - description (Markdown), subtasks (tap the glyph to complete, tap the row
 *    to open, + 添加子任务), the comment thread (long-press: copy / delete;
 *    a failed load says so and offers a retry),
 *  - a Liquid Glass comment composer pinned above the keyboard.
 *
 * Navigation bar: pencil = edit (form sheet); `…` = 状态 submenu / 添加子任务 /
 * 里程碑 / 删除. The API has no single-task GET — the task is found in the
 * project's tree from the shared projects store (refetched on focus).
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { addComment, deleteComment, listComments, updateTask, type Priority, type ProjectTask, type TaskComment } from '../../../src/api/projects';
import { Markdown } from '../../../src/chat/markdown';
import { relativeTime } from '../../../src/lib/format';
import { useT } from '../../../src/lib/i18n';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useAuth } from '../../../src/store/auth';
import { usePrefs } from '../../../src/store/prefs';
import {
  PRIORITIES,
  TASK_STATUSES,
  findTask,
  forEachTask,
  formatDay,
  isMilestone,
  isOverdue,
  parseDeps,
  parseTags,
  priorityColor,
  priorityLabel,
  projectAccess,
  projectColor,
  taskStatusColor,
  taskStatusIcon,
  taskStatusLabel,
  taskStatusTone,
} from '../../../src/projects/meta';
import { useAssignableUsers, useProjectDetail, useProjects } from '../../../src/projects/store';
import { useTaskActions } from '../../../src/projects/task-actions';
import { TaskStatusButton } from '../../../src/projects/task-list';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../../src/theme';
import { Icon } from '../../../src/ui/core';
import { InitialAvatar } from '../../../src/ui/avatar';
import { alertError, confirmAction } from '../../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { Glass, GlassGroup, GlassIconButton } from '../../../src/ui/glass';
import { tapLight } from '../../../src/ui/haptics';
import { Badge, ListRow, ListSection, type ListRowProps } from '../../../src/ui/list';
import { NativeMenu, menuSections, type MenuItem } from '../../../src/ui/menu';
import { toast } from '../../../src/ui/toast';

export default function TaskDetailScreen() {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const lang = usePrefs((s) => s.lang);
  const me = useAuth((s) => s.user);
  const params = useLocalSearchParams<{ taskId: string; projectId: string }>();
  const taskId = Number(params.taskId);
  const projectId = Number(params.projectId);

  const { detail, failed, reload } = useProjectDetail(projectId, { refetchOnFocus: true });
  const patchTask = useProjects((s) => s.patchTask);
  const users = useAssignableUsers();
  const actions = useTaskActions(projectId);
  const [comments, setComments] = useState<TaskComment[] | null>(null);
  const [commentsFailed, setCommentsFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  // Refetch on focus; a failure keeps what's shown (or flags the empty thread).
  const commentsSeq = useRef(0);
  const loadComments = useCallback(() => {
    const mine = ++commentsSeq.current;
    void listComments(taskId).then((rows) => {
      if (mine !== commentsSeq.current) return;
      if (rows) setComments(rows);
      else setComments((prev) => prev ?? []);
      setCommentsFailed(!rows);
    });
  }, [taskId]);
  useFocusEffect(
    useCallback(() => {
      loadComments();
      return () => {
        commentsSeq.current++; // drop a response that lands after blur / unmount
      };
    }, [loadComments]),
  );

  // Nav-bar title appears once the heading has scrolled under the bar.
  const titleBottom = useRef(0);
  const [navTitle, setNavTitle] = useState(false);
  const navTitleRef = useRef(false);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const under = e.nativeEvent.contentOffset.y + headerHeight > titleBottom.current;
      if (under !== navTitleRef.current) {
        navTitleRef.current = under;
        setNavTitle(under);
      }
    },
    [headerHeight],
  );

  const task = useMemo(() => (detail ? findTask(detail.tasks, taskId) : null), [detail, taskId]);
  const access = detail ? projectAccess(detail.project, detail.members, me) : { canWrite: false, canManage: false };

  // Parent + dependency titles (resolved against the whole project tree).
  const related = useMemo(() => {
    if (!task || !detail) return { parent: null as ProjectTask | null, deps: [] as ProjectTask[] };
    const wanted = new Set(parseDeps(task.dependencies));
    const deps: ProjectTask[] = [];
    forEachTask(detail.tasks, (x) => {
      if (wanted.has(x.id)) deps.push(x);
    });
    return { parent: task.parent_id ? findTask(detail.tasks, task.parent_id) : null, deps };
  }, [task, detail]);

  // ── in-place field edits (status / priority / assignee) ──
  const patch = useCallback(
    async (body: Parameters<typeof updateTask>[1], local: Partial<ProjectTask>) => {
      if (!task) return;
      patchTask(projectId, task.id, local);
      const ok = !!(await updateTask(task.id, body));
      // the fresh reload below rolls the optimistic patch back on failure
      if (!ok) alertError(t('projects.updateFailed'));
      void reload({ fresh: true });
    },
    [task, patchTask, projectId, reload, t],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    tapLight();
    setSending(true);
    const created = await addComment(taskId, text);
    setSending(false);
    if (!created) {
      alertError(t('projects.commentFailed'));
      return;
    }
    setDraft('');
    setComments((prev) => [...(prev ?? []), { ...created, user_nickname: created.user_nickname ?? me?.nickname }]);
  }, [draft, sending, taskId, t, me]);

  const onCommentMenu = useCallback(
    async (cm: TaskComment, id: string) => {
      if (id === 'copy') {
        await Clipboard.setStringAsync(cm.content).catch(() => {});
        toast(t('common.copied'), 'copy');
        return;
      }
      if (id !== 'delete') return;
      const yes = await confirmAction({
        title: t('projects.deleteComment'),
        confirmLabel: t('common.delete'),
        destructive: true,
      });
      if (!yes) return;
      if (await deleteComment(cm.id)) setComments((prev) => (prev ?? []).filter((x) => x.id !== cm.id));
      else alertError(t('projects.deleteFailed'));
    },
    [t],
  );

  const deleteThis = useCallback(async () => {
    if (task && (await actions.remove(task))) router.back();
  }, [task, actions, router]);

  // ── keyboard-pinned composer ──
  const { height: kbHeight, progress: kbProgress } = useReanimatedKeyboardAnimation();
  const composerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: kbHeight.value + insets.bottom * kbProgress.value }],
  }));

  const showComposer = !!task && access.canWrite;
  const pid = String(projectId);

  if (!task) {
    return (
      <>
        <Stack.Screen options={{ title: '' }} />
        {detail || failed ? (
          <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
            {detail ? (
              <EmptyState icon="alert" title={t('projects.taskMissing')} />
            ) : (
              <EmptyState
                icon="alert"
                title={t('projects.projectMissing')}
                message={t('projects.projectMissingHint')}
                onRetry={() => void reload()}
              />
            )}
          </ScrollView>
        ) : (
          <LoadingState style={{ paddingTop: headerHeight }} />
        )}
      </>
    );
  }

  const overdue = isOverdue(task);
  const tags = parseTags(task.tags);
  const kids = task.children ?? [];
  const statusItems: MenuItem[] = TASK_STATUSES.map((s) => ({
    id: s,
    title: taskStatusLabel(s, t),
    icon: taskStatusIcon(s),
    checked: s === task.status,
  }));
  const priorityItems: MenuItem[] = PRIORITIES.map((p) => ({ id: p, title: priorityLabel(p, t), checked: p === task.priority }));
  const assigneeItems: MenuItem[] = menuSections([
    [{ id: '', title: t('projects.unassigned'), checked: !task.assignee_id }],
    users.map((u) => ({ id: u.id, title: u.nickname, checked: u.id === task.assignee_id })),
  ]);
  const canDeleteComment = (cm: TaskComment) => !!me && (cm.user_id === me.id || access.canManage);

  return (
    <>
      <Stack.Screen options={{ title: navTitle ? task.title : '' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="pencil"
          hidden={!access.canWrite}
          onPress={() => actions.edit(task)}
          accessibilityLabel={t('projects.editTask')}
        />
        <Stack.Toolbar.Menu icon="ellipsis" hidden={!access.canWrite} accessibilityLabel={t('common.more')}>
          <Stack.Toolbar.Menu title={t('projects.changeStatus')} icon="circle.lefthalf.filled">
            {TASK_STATUSES.map((s) => (
              <Stack.Toolbar.MenuAction key={s} isOn={task.status === s} onPress={() => void actions.setStatus(task, s)}>
                {taskStatusLabel(s, t)}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction icon="arrow.turn.down.right" onPress={() => actions.addSubtask(task)}>
              {t('projects.newSubtask')}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="diamond" onPress={() => void actions.toggleMilestone(task)}>
              {isMilestone(task) ? t('projects.unmakeMilestone') : t('projects.makeMilestone')}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.MenuAction icon="trash" destructive onPress={() => void deleteThis()}>
            {t('projects.deleteTask')}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: (showComposer ? 76 : space.xxl) + insets.bottom }}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {/* ── header ── */}
        <View style={styles.head}>
          <Text
            selectable
            accessibilityRole="header"
            onLayout={(e) => {
              // the header block is the first thing in the scroll content
              titleBottom.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height;
            }}
            style={[styles.title, task.status === 'cancelled' && styles.titleCancelled]}
          >
            {task.title}
          </Text>
          <View style={styles.pills}>
            <Badge icon={taskStatusIcon(task.status)} label={taskStatusLabel(task.status, t)} tone={taskStatusTone(task.status)} />
            {isMilestone(task) ? <Badge icon="diamondFill" label={t('projects.milestone')} tone="orange" /> : null}
            {overdue ? <Badge icon="alert" label={t('projects.overdue')} tone="red" /> : null}
          </View>
          {detail ? (
            <View style={styles.projectLine}>
              <View style={[styles.projectDot, { backgroundColor: projectColor(detail.project.color, hex) }]} />
              <Text numberOfLines={1} style={styles.projectName}>
                {detail.project.title}
              </Text>
            </View>
          ) : null}
        </View>

        {/* ── details ── */}
        <ListSection>
          <MenuRow
            enabled={access.canWrite}
            items={statusItems}
            onSelect={(s) => void actions.setStatus(task, s as ProjectTask['status'])}
            title={t('projects.status')}
            icon={taskStatusIcon(task.status)}
            iconTint={taskStatusColor(task.status, c)}
            value={taskStatusLabel(task.status, t)}
          />
          <MenuRow
            enabled={access.canWrite}
            items={priorityItems}
            onSelect={(p) => void patch({ priority: p as Priority }, { priority: p as Priority })}
            title={t('projects.priority')}
            icon="flagFill"
            iconTint={priorityColor(task.priority, c)}
            value={priorityLabel(task.priority, t)}
          />
          <MenuRow
            enabled={access.canWrite}
            items={assigneeItems}
            onSelect={(id) => {
              const nick = users.find((u) => u.id === id)?.nickname ?? null;
              void patch({ assignee_id: id || null }, { assignee_id: id || null, assignee_nickname: id ? nick : null });
            }}
            title={t('projects.assignee')}
            icon="person2"
            iconTint={c.indigo}
            value={task.assignee_nickname ?? t('projects.unassigned')}
          />
          <ListRow
            title={t('projects.startDate')}
            icon="calendar"
            iconTint={c.blue}
            value={task.start_date ? formatDay(task.start_date, lang) : t('projects.noDate')}
            accessory={access.canWrite ? 'chevron' : 'none'}
            onPress={access.canWrite ? () => actions.edit(task) : undefined}
          />
          <ListRow
            title={t('projects.dueDate')}
            icon="calendar"
            iconTint={overdue ? c.red : c.orange}
            value={task.due_date ? formatDay(task.due_date, lang) : t('projects.noDate')}
            accessory={access.canWrite ? 'chevron' : 'none'}
            onPress={access.canWrite ? () => actions.edit(task) : undefined}
          />
          {related.parent ? (
            <ListRow
              title={t('projects.parentTask')}
              icon="subtask"
              iconTint={c.gray}
              value={related.parent.title}
              accessory="chevron"
              onPress={() => actions.open(related.parent!)}
            />
          ) : null}
          {task.estimated_hours != null ? (
            <ListRow title={t('projects.estimatedHours')} icon="hourglass" iconTint={c.purple} value={`${task.estimated_hours} h`} />
          ) : null}
          {tags.length > 0 ? <ListRow title={t('projects.tags')} icon="tag" iconTint={c.blue} value={tags.join(' · ')} /> : null}
        </ListSection>

        {related.deps.length > 0 ? (
          <ListSection header={t('projects.dependencies')}>
            {related.deps.map((dep) => (
              <ListRow
                key={dep.id}
                title={dep.title}
                leading={<TaskStatusButton task={dep} size={22} />}
                accessory="chevron"
                onPress={() => actions.open(dep)}
              />
            ))}
          </ListSection>
        ) : null}

        {task.description ? (
          <View style={styles.section}>
            <Text style={styles.sectionHeader}>{t('projects.description')}</Text>
            <View style={styles.card}>
              <Markdown source={task.description} />
            </View>
          </View>
        ) : null}

        {kids.length > 0 || access.canWrite ? (
          <ListSection header={kids.length ? `${t('projects.subtasks')} · ${kids.filter((k) => k.status === 'done').length}/${kids.length}` : t('projects.subtasks')}>
            {kids.map((child) => (
              <ListRow
                key={child.id}
                title={child.title}
                leading={
                  <TaskStatusButton
                    task={child}
                    size={22}
                    onToggle={access.canWrite ? () => void actions.setStatus(child, child.status === 'done' ? 'todo' : 'done') : undefined}
                  />
                }
                accessory="chevron"
                onPress={() => actions.open(child)}
              />
            ))}
            {access.canWrite ? (
              <ListRow
                title={t('projects.newSubtask')}
                leading={<Icon name="plusCircle" size={22} color={c.accent} />}
                onPress={() =>
                  router.push({ pathname: '/projects/task-form', params: { projectId: pid, parentId: String(task.id) } })
                }
              />
            ) : null}
          </ListSection>
        ) : null}

        {/* ── comments ── */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>
            {t('projects.comments')}
            {comments && comments.length > 0 ? ` · ${comments.length}` : ''}
          </Text>
          {comments === null ? (
            <LoadingState style={styles.commentsLoading} />
          ) : comments.length === 0 && commentsFailed ? (
            <EmptyState icon="comment" title={t('projects.commentsFailed')} onRetry={loadComments} style={styles.commentsFailed} />
          ) : comments.length === 0 ? (
            <Text style={styles.noComments}>{t('projects.noComments')}</Text>
          ) : (
            <View style={styles.card}>
              {comments.map((cm, i) => (
                <CommentRow
                  key={cm.id}
                  comment={cm}
                  last={i === comments.length - 1}
                  items={menuSections([
                    [{ id: 'copy', title: t('projects.copyComment'), icon: 'copy' }],
                    canDeleteComment(cm) ? [{ id: 'delete', title: t('common.delete'), icon: 'trash', destructive: true }] : [],
                  ])}
                  onSelect={(id) => void onCommentMenu(cm, id)}
                />
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {showComposer ? (
        <Animated.View style={[styles.composerWrap, { paddingBottom: insets.bottom + space.sm }, composerStyle]}>
          <GlassGroup spacing={10} style={styles.composerRow}>
            <Glass style={styles.inputGlass}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder={t('projects.commentPlaceholder')}
                placeholderTextColor={c.placeholder}
                multiline
                style={styles.input}
              />
            </Glass>
            <GlassIconButton
              icon="up"
              prominent
              size={40}
              disabled={!draft.trim() || sending}
              onPress={() => void send()}
              accessibilityLabel={t('projects.sendComment')}
            />
          </GlassGroup>
        </Animated.View>
      ) : null}
    </>
  );
}

// ─── Pieces ──────────────────────────────────────────────

/** A details row whose value is a pop-up menu (Settings / Reminders style). */
function MenuRow({
  enabled,
  items,
  onSelect,
  last,
  ...row
}: Omit<ListRowProps, 'accessory' | 'onPress'> & { enabled: boolean; items: MenuItem[]; onSelect: (id: string) => void }) {
  const { colors: c } = useTheme();
  if (!enabled) return <ListRow {...row} last={last} />;
  return (
    <NativeMenu trigger="tap" fill items={items} onSelect={onSelect}>
      <ListRow {...row} last={last} accessory={<Icon name="chevUpDown" size={13} weight="semibold" color={c.tertiaryLabel} />} />
    </NativeMenu>
  );
}

function CommentRow({
  comment,
  last,
  items,
  onSelect,
}: {
  comment: TaskComment;
  last: boolean;
  items: MenuItem[];
  onSelect: (id: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const name = comment.user_nickname ?? comment.user_id;
  return (
    <NativeMenu trigger="longPress" items={items} onSelect={onSelect}>
      <View style={styles.comment}>
        <InitialAvatar name={name} size={30} tint={c.gray} />
        <View style={styles.commentBody}>
          <View style={styles.commentHead}>
            <Text numberOfLines={1} style={styles.commentAuthor}>
              {name}
            </Text>
            <Text style={styles.commentTime}>{relativeTime(comment.created_at)}</Text>
          </View>
          <Text style={styles.commentText}>{comment.content}</Text>
        </View>
        {!last ? <View pointerEvents="none" style={styles.commentSep} /> : null}
      </View>
    </NativeMenu>
  );
}

const useStyles = makeStyles((c) => ({
  head: { paddingHorizontal: space.margin + space.xs, paddingTop: space.sm, paddingBottom: space.xl, gap: space.sm + 2 },
  title: { ...typo.title1, color: c.label },
  titleCancelled: { textDecorationLine: 'line-through', color: c.secondaryLabel },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  projectLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm - 2 },
  projectDot: { width: 9, height: 9, borderRadius: 5 },
  projectName: { ...typo.subheadline, color: c.secondaryLabel, flexShrink: 1 },

  section: { marginHorizontal: space.margin, marginBottom: space.xxl },
  sectionHeader: {
    ...typo.footnote,
    color: c.secondaryLabel,
    textTransform: 'uppercase',
    paddingHorizontal: space.margin,
    paddingBottom: space.sm - 2,
  },
  card: {
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.group,
    ...squircle,
    paddingHorizontal: space.margin,
    paddingVertical: space.xs,
    overflow: 'hidden',
  },
  noComments: { ...typo.subheadline, color: c.tertiaryLabel, paddingHorizontal: space.margin },
  commentsLoading: { flexGrow: 0, paddingVertical: space.lg },
  commentsFailed: { paddingVertical: space.sm },

  comment: { flexDirection: 'row', gap: space.md, paddingVertical: space.md, minHeight: HIT },
  commentBody: { flex: 1, minWidth: 0, gap: 2 },
  commentHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  commentAuthor: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label, flexShrink: 1 },
  commentTime: { ...typo.footnote, color: c.tertiaryLabel },
  commentText: { ...typo.body, color: c.label },
  commentSep: {
    position: 'absolute',
    right: -space.margin,
    bottom: 0,
    left: 30 + space.md,
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.separator,
  },

  composerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: space.md },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  inputGlass: { flex: 1, borderRadius: 22, minHeight: 44, justifyContent: 'center' },
  input: {
    ...typo.body,
    color: c.label,
    paddingHorizontal: space.lg,
    paddingTop: 11,
    paddingBottom: 11,
    maxHeight: 120,
  },
}));
