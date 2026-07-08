/**
 * Task detail — fields, markdown description, subtasks, dependencies and the
 * comment stream (web parity: task-drawer.tsx). The task itself comes from the
 * project's task tree (the API has no single-task GET); edits go through the
 * shared TaskFormSheet / TaskActionsHost.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  addComment,
  deleteComment,
  getProject,
  listAssignableUsers,
  listComments,
  type AssignableUser,
  type ProjectTask,
  type TaskComment,
} from '../../../src/api/projects';
import { Markdown } from '../../../src/chat/markdown';
import { relativeTime } from '../../../src/lib/format';
import { useT } from '../../../src/lib/i18n';
import { useBottomPadStyle } from '../../../src/lib/keyboard';
import { useAuth } from '../../../src/store/auth';
import {
  findTask,
  forEachTask,
  isOverdue,
  parseDeps,
  parseTags,
  priorityColor,
  priorityLabel,
  shortDate,
  taskStatusColor,
  taskStatusIcon,
  taskStatusLabel,
  taskStatusTint,
} from '../../../src/projects/meta';
import { TaskActionsHost } from '../../../src/projects/task-action-sheets';
import { TaskFormSheet } from '../../../src/projects/task-form-sheet';
import { EmptyState, Field, Icon, ScreenHeader, Skeleton, Touchable, UserAvatar } from '../../../src/ui';
import Animated from 'react-native-reanimated';
import { font, makeStyles, radius, useTheme, weight } from '../../../src/theme';

export default function TaskDetailScreen() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const me = useAuth((s) => s.user);
  const params = useLocalSearchParams<{ taskId: string; projectId: string; title?: string }>();
  const taskId = Number(params.taskId);
  const projectId = Number(params.projectId);

  const [tree, setTree] = useState<ProjectTask[] | null>(null);
  const [comments, setComments] = useState<TaskComment[] | null>(null);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [subtaskFormOpen, setSubtaskFormOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const rootPad = useBottomPadStyle(0);

  const load = useCallback(async () => {
    const [detail, cms] = await Promise.all([getProject(projectId), listComments(taskId)]);
    setTree(detail?.tasks ?? []);
    setComments(cms);
  }, [projectId, taskId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    void listAssignableUsers().then(setUsers);
  }, []);

  const task = useMemo(() => (tree ? findTask(tree, taskId) : null), [tree, taskId]);

  // Dependency ids → titles (resolved against the whole project tree).
  const depTitles = useMemo(() => {
    if (!task || !tree) return [];
    const wanted = new Set(parseDeps(task.dependencies));
    const out: string[] = [];
    forEachTask(tree, (candidate) => {
      if (wanted.has(candidate.id)) out.push(candidate.title);
    });
    return out;
  }, [task, tree]);

  const send = useCallback(async () => {
    const text = comment.trim();
    if (!text || sending) return;
    setSending(true);
    const created = await addComment(taskId, text);
    setSending(false);
    if (created) {
      setComment('');
      setComments((prev) => [...(prev ?? []), created]);
    }
  }, [comment, sending, taskId]);

  const removeComment = useCallback(
    (cm: TaskComment) => {
      void deleteComment(cm.id).then((ok) => {
        if (ok) setComments((prev) => (prev ?? []).filter((x) => x.id !== cm.id));
      });
    },
    [],
  );

  const tags = task ? parseTags(task.tags) : [];

  return (
    <Animated.View style={[styles.root, { paddingTop: insets.top + 2 }, rootPad]}>
      <ScreenHeader
        variant="compact"
        align="left"
        title={task?.title ?? params.title ?? t('projects.title')}
        onLeading={() => router.back()}
        right={
          task ? (
            <Touchable haptic="none" onPress={() => setActionsOpen(true)} style={styles.headerBtn} accessibilityLabel="menu">
              <Icon name="more" size={20} color={c.fg} />
            </Touchable>
          ) : undefined
        }
      />

      {tree === null ? (
        <View style={{ paddingHorizontal: 16, gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} style={{ height: 60, borderRadius: radius.md }} />
          ))}
        </View>
      ) : !task ? (
        <EmptyState icon="alert" title={t('projects.taskMissing')} />
      ) : (
        <FlatList
          data={comments ?? []}
          keyExtractor={(cm) => String(cm.id)}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View style={{ gap: 14, paddingBottom: 14 }}>
              {/* status / priority / milestone strip */}
              <View style={styles.pillRow}>
                <View style={[styles.statusPill, { backgroundColor: taskStatusTint(task.status, c) }]}>
                  <Icon name={taskStatusIcon(task.status)} size={13} color={taskStatusColor(task.status, c)} />
                  <Text style={[styles.statusPillText, { color: taskStatusColor(task.status, c) }]}>
                    {taskStatusLabel(task.status, t)}
                  </Text>
                </View>
                {task.task_type === 'milestone' ? (
                  <View style={[styles.statusPill, { backgroundColor: c.warningTint }]}>
                    <Icon name="diamond" size={12} color={c.warning} />
                    <Text style={[styles.statusPillText, { color: c.warning }]}>{t('projects.milestone')}</Text>
                  </View>
                ) : null}
                {isOverdue(task) ? (
                  <View style={[styles.statusPill, { backgroundColor: c.dangerTint }]}>
                    <Text style={[styles.statusPillText, { color: c.danger }]}>{t('projects.overdue')}</Text>
                  </View>
                ) : null}
              </View>

              {/* field grid */}
              <View style={styles.fieldCard}>
                <FieldRow label={t('projects.assignee')} value={task.assignee_nickname ?? t('projects.unassigned')} />
                <FieldRow label={t('projects.priority')} value={priorityLabel(task.priority, t)} valueColor={priorityColor(task.priority, c)} />
                <FieldRow label={t('projects.startDate')} value={task.start_date ? shortDate(task.start_date) : '—'} />
                <FieldRow
                  label={t('projects.dueDate')}
                  value={task.due_date ? shortDate(task.due_date) : '—'}
                  valueColor={isOverdue(task) ? c.danger : undefined}
                />
                {task.estimated_hours != null ? <FieldRow label={t('projects.estimatedHours')} value={`${task.estimated_hours}h`} /> : null}
                {tags.length > 0 ? <FieldRow label={t('projects.tags')} value={tags.join(' · ')} /> : null}
              </View>

              {/* description */}
              {task.description ? (
                <View>
                  <Text style={styles.sectionTitle}>{t('projects.description')}</Text>
                  <View style={styles.descCard}>
                    <Markdown source={task.description} />
                  </View>
                </View>
              ) : null}

              {/* dependencies */}
              {depTitles.length > 0 ? (
                <View>
                  <Text style={styles.sectionTitle}>{t('projects.dependencies')}</Text>
                  <View style={styles.depWrap}>
                    {depTitles.map((title, i) => (
                      <View key={i} style={styles.depChip}>
                        <Text numberOfLines={1} style={styles.depChipText}>
                          {title}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              {/* subtasks */}
              {task.children?.length ? (
                <View>
                  <Text style={styles.sectionTitle}>
                    {t('projects.subtasks')} ({task.children.length})
                  </Text>
                  {task.children.map((child) => (
                    <Touchable
                      key={child.id}
                      haptic="none"
                      pressedStyle={{ opacity: 0.7 }}
                      onPress={() =>
                        router.push({
                          pathname: '/projects/task/[taskId]',
                          params: { taskId: String(child.id), projectId: String(projectId), title: child.title },
                        })
                      }
                      style={styles.subtaskRow}
                    >
                      <Icon name={taskStatusIcon(child.status)} size={14} color={taskStatusColor(child.status, c)} />
                      <Text numberOfLines={1} style={[styles.subtaskText, child.status === 'done' && styles.subtaskDone]}>
                        {child.title}
                      </Text>
                      <Icon name="chevR" size={14} color={c.fgFaint} />
                    </Touchable>
                  ))}
                </View>
              ) : null}

              <Text style={styles.sectionTitle}>
                {t('projects.comments')}
                {comments && comments.length > 0 ? ` (${comments.length})` : ''}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <Touchable
              haptic="none"
              onLongPress={me && item.user_id === me.id ? () => removeComment(item) : undefined}
              pressedStyle={{}}
              style={styles.commentRow}
            >
              <UserAvatar size={28} label={(item.user_nickname ?? item.user_id).slice(0, 1)} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={styles.commentHead}>
                  <Text style={styles.commentAuthor}>{item.user_nickname ?? item.user_id}</Text>
                  <Text style={styles.commentTime}>{relativeTime(item.created_at)}</Text>
                </View>
                <Text style={styles.commentBody}>{item.content}</Text>
              </View>
            </Touchable>
          )}
        />
      )}

      {/* comment composer */}
      {task ? (
        <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          <View style={{ flex: 1 }}>
            <Field placeholder={t('projects.commentPlaceholder')} value={comment} onChangeText={setComment} multiline style={{ maxHeight: 90 }} />
          </View>
          <Touchable
            haptic="light"
            accessibilityLabel={t('projects.comments')}
            onPress={() => void send()}
            disabled={sending || !comment.trim()}
            style={[styles.sendBtn, (!comment.trim() || sending) && { opacity: 0.4 }]}
          >
            <Icon name="up" size={20} color={c.onAccent} sw={2.4} />
          </Touchable>
        </View>
      ) : null}

      {task ? (
        <>
          <TaskActionsHost
            task={actionsOpen ? task : null}
            onClose={() => setActionsOpen(false)}
            onChanged={() => void load()}
            onEdit={() => setEditOpen(true)}
            onAddSubtask={() => setSubtaskFormOpen(true)}
            showView={false}
          />
          <TaskFormSheet
            visible={editOpen}
            onClose={() => setEditOpen(false)}
            projectId={projectId}
            task={task}
            users={users}
            onSaved={() => void load()}
          />
          <TaskFormSheet
            visible={subtaskFormOpen}
            onClose={() => setSubtaskFormOpen(false)}
            projectId={projectId}
            parentId={task.id}
            users={users}
            onSaved={() => void load()}
          />
        </>
      ) : null}
    </Animated.View>
  );
}

function FieldRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text numberOfLines={1} style={[styles.fieldValue, valueColor ? { color: valueColor } : null]}>
        {value}
      </Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  headerBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },

  pillRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
  },
  statusPillText: { fontSize: font.caption, fontWeight: weight.semibold },

  fieldCard: {
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.hairline,
    paddingHorizontal: 14,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  fieldLabel: { fontSize: font.small, color: c.fgMuted },
  fieldValue: { flex: 1, textAlign: 'right', fontSize: font.small, color: c.fg, fontWeight: weight.medium },

  sectionTitle: { fontSize: font.small, fontWeight: weight.semibold, color: c.fgMuted, marginBottom: 8 },
  descCard: {
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.hairline,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },

  depWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  depChip: {
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
    backgroundColor: c.surfaceMuted,
  },
  depChipText: { fontSize: font.caption, color: c.fgSecondary },

  subtaskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.hairline,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 6,
  },
  subtaskText: { flex: 1, fontSize: font.label, color: c.fg },
  subtaskDone: { textDecorationLine: 'line-through', color: c.fgFaint },

  commentRow: { flexDirection: 'row', gap: 10, paddingVertical: 9 },
  commentHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  commentAuthor: { fontSize: font.small, fontWeight: weight.semibold, color: c.fg },
  commentTime: { fontSize: font.caption, color: c.fgFaint },
  commentBody: { fontSize: font.label, color: c.fgSecondary, marginTop: 3, lineHeight: 20 },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: c.hairline,
    backgroundColor: c.bg,
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
