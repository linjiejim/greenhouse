/**
 * 创建任务/里程碑对话框 — 支持创建顶级任务、子任务和里程碑。
 */

import React, { useState, useEffect } from 'react';
import { Button, Dialog } from '../ui';
import { FormActions, FormError } from '../form';
import { authFetch } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { EMPTY_TASK_FORM, TaskForm, type TaskFormValue } from './task-form';

export function CreateTaskDialog({
  open,
  onClose,
  onCreated,
  projectId,
  parentId,
  users,
  taskType,
  initialStartDate,
  initialDueDate,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  projectId: number;
  parentId?: number;
  users: Array<{ id: string; nickname: string }>;
  taskType?: string;
  initialStartDate?: string;
  initialDueDate?: string;
}) {
  const t = useT();
  const isMilestone = taskType === 'milestone';
  const [form, setForm] = useState<TaskFormValue>(EMPTY_TASK_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Reset form when dialog opens with new initial values
  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY_TASK_FORM, start_date: initialStartDate || '', due_date: initialDueDate || '' });
      setError('');
    }
  }, [open, initialStartDate, initialDueDate]);

  const handleSubmit = async () => {
    if (!form.title.trim()) {
      setError(isMilestone ? t('task.milestoneNameRequired') : t('task.taskTitleRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        title: form.title.trim(),
        description: form.description || undefined,
        priority: form.priority,
        parent_id: parentId || undefined,
        assignee_id: form.assignee_id || undefined,
        estimated_hours: form.estimated_hours ? parseInt(form.estimated_hours) : undefined,
      };

      if (isMilestone) {
        body.task_type = 'milestone';
        body.due_date = form.due_date || undefined;
        body.start_date = form.due_date || undefined; // milestone: single date
      } else {
        body.start_date = form.start_date || undefined;
        body.due_date = form.due_date || undefined;
      }

      const res = await authFetch(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setForm(EMPTY_TASK_FORM);
        onCreated();
        onClose();
      } else {
        const data = await res.json();
        setError(data.error || t('common.createFailed'));
      }
    } catch (_err) {
      setError(t('common.networkError'));
    }
    setSaving(false);
  };

  const dialogTitle = isMilestone
    ? t('task.createMilestone')
    : parentId
      ? t('task.createSubtask')
      : t('task.createTask');

  return (
    <Dialog open={open} onClose={onClose} title={dialogTitle} size="lg">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        {isMilestone && (
          <div className="flex items-center gap-2 p-2 bg-warning-subtle border border-warning rounded-lg text-xs text-warning">
            <span className="text-star text-sm">◆</span>
            {t('task.milestoneHint')}
          </div>
        )}
        <TaskForm value={form} onChange={setForm} users={users} isMilestone={isMilestone} />
        <FormError>{error}</FormError>
        <FormActions>
          <Button variant="ghost" size="sm" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" type="submit" disabled={saving}>
            {saving ? t('projects.creating') : t('common.create')}
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
