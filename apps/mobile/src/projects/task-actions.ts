/**
 * Task actions — the one implementation behind every task context menu (list
 * rows, board cards, gantt labels) and the task page's toolbar menu.
 *
 * Touch replacement for the web's drag + right-click interactions: status
 * changes (a submenu with checkmarks, applied optimistically), edit, add a
 * subtask, milestone toggle and delete (system confirm). Forms open as sheet
 * routes; results come back through the projects store (src/projects/store).
 * Feedback: a failed write is a system alert (`alertError`) and the optimistic
 * change is rolled back by a fresh reload; successes toast where the result
 * isn't already visible (milestone, delete).
 */

import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { deleteTask, updateTask, type ProjectTask, type TaskStatus } from '../api/projects';
import { useT } from '../lib/i18n';
import { alertError, confirmAction } from '../ui/dialogs';
import { menuSections, type MenuItem } from '../ui/menu';
import { toast } from '../ui/toast';
import { selectionTick } from '../ui/haptics';
import { TASK_STATUSES, isMilestone, taskStatusIcon, taskStatusLabel } from './meta';
import { useProjects } from './store';

export function useTaskActions(projectId: number) {
  const t = useT();
  const router = useRouter();
  const reload = useProjects((s) => s.reload);
  const patchTask = useProjects((s) => s.patchTask);

  const open = useCallback(
    (task: ProjectTask) =>
      router.push({ pathname: '/projects/task/[taskId]', params: { taskId: String(task.id), projectId: String(projectId) } }),
    [router, projectId],
  );

  const edit = useCallback(
    (task: ProjectTask) =>
      router.push({ pathname: '/projects/task-form', params: { projectId: String(projectId), taskId: String(task.id) } }),
    [router, projectId],
  );

  const addSubtask = useCallback(
    (task: ProjectTask) =>
      router.push({ pathname: '/projects/task-form', params: { projectId: String(projectId), parentId: String(task.id) } }),
    [router, projectId],
  );

  // After any write: a fresh reload, never one that was already in flight.
  const refresh = useCallback(() => void reload(projectId, { fresh: true }), [reload, projectId]);

  // A failed write: say so, and reload to roll back the optimistic patch.
  const failed = useCallback(
    (title: string) => {
      alertError(title);
      refresh();
    },
    [refresh],
  );

  const setStatus = useCallback(
    async (task: ProjectTask, status: TaskStatus) => {
      if (task.status === status) return;
      selectionTick();
      patchTask(projectId, task.id, { status });
      const ok = !!(await updateTask(task.id, { status }));
      if (!ok) return failed(t('projects.updateFailed'));
      refresh();
    },
    [patchTask, projectId, refresh, failed, t],
  );

  const toggleMilestone = useCallback(
    async (task: ProjectTask) => {
      const next = isMilestone(task) ? 'task' : 'milestone';
      patchTask(projectId, task.id, { task_type: next });
      const ok = !!(await updateTask(task.id, { task_type: next }));
      if (!ok) return failed(t('projects.updateFailed'));
      toast(next === 'milestone' ? t('projects.madeMilestone') : t('projects.unmadeMilestone'), 'diamond');
      refresh();
    },
    [patchTask, projectId, refresh, failed, t],
  );

  /** Confirm + delete; resolves true once the task is gone. */
  const remove = useCallback(
    async (task: ProjectTask): Promise<boolean> => {
      const yes = await confirmAction({
        title: t('projects.deleteTask'),
        message: t('projects.deleteTaskConfirm', { name: task.title }),
        confirmLabel: t('common.delete'),
        destructive: true,
      });
      if (!yes) return false;
      const ok = await deleteTask(task.id);
      if (!ok) {
        failed(t('projects.deleteFailed'));
        return false;
      }
      toast(t('projects.taskDeleted'), 'trash');
      refresh();
      return true;
    },
    [t, failed, refresh],
  );

  /** Context-menu items for a task. `withOpen` adds 打开 at the top (rows/cards). */
  const menuItems = useCallback(
    (task: ProjectTask, { withOpen = true }: { withOpen?: boolean } = {}): MenuItem[] =>
      menuSections([
        withOpen ? [{ id: 'open', title: t('projects.viewDetail'), icon: 'open' }] : [],
        [
          {
            id: 'status',
            title: t('projects.changeStatus'),
            icon: taskStatusIcon(task.status),
            children: TASK_STATUSES.map((s) => ({
              id: `status:${s}`,
              title: taskStatusLabel(s, t),
              icon: taskStatusIcon(s),
              checked: s === task.status,
            })),
          },
        ],
        [
          { id: 'edit', title: t('projects.editTask'), icon: 'pen' },
          { id: 'subtask', title: t('projects.newSubtask'), icon: 'subtask' },
          {
            id: 'milestone',
            title: isMilestone(task) ? t('projects.unmakeMilestone') : t('projects.makeMilestone'),
            icon: 'diamond',
          },
        ],
        [{ id: 'delete', title: t('projects.deleteTask'), icon: 'trash', destructive: true }],
      ]),
    [t],
  );

  const onSelect = useCallback(
    (task: ProjectTask, id: string) => {
      if (id === 'open') open(task);
      else if (id === 'edit') edit(task);
      else if (id === 'subtask') addSubtask(task);
      else if (id === 'milestone') void toggleMilestone(task);
      else if (id === 'delete') void remove(task);
      else if (id.startsWith('status:')) void setStatus(task, id.slice(7) as TaskStatus);
    },
    [open, edit, addSubtask, toggleMilestone, remove, setStatus],
  );

  return { menuItems, onSelect, open, edit, addSubtask, setStatus, toggleMilestone, remove };
}
