/**
 * 创建任务/里程碑对话框 — 支持创建顶级任务、子任务和里程碑。
 */

import React, { useState, useEffect } from 'react';
import { Button, Input, Select, Dialog, Textarea } from '../ui';
import { authFetch } from '../../lib/auth';
import { useT } from '../../lib/i18n';

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
  const [form, setForm] = useState({
    title: '',
    description: '',
    priority: 'normal',
    assignee_id: '',
    start_date: '',
    due_date: '',
    estimated_hours: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Reset form when dialog opens with new initial values
  useEffect(() => {
    if (open) {
      setForm({
        title: '',
        description: '',
        priority: 'normal',
        assignee_id: '',
        start_date: initialStartDate || '',
        due_date: initialDueDate || '',
        estimated_hours: '',
      });
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
        setForm({
          title: '',
          description: '',
          priority: 'normal',
          assignee_id: '',
          start_date: '',
          due_date: '',
          estimated_hours: '',
        });
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
      <div className="space-y-3">
        {isMilestone && (
          <div className="flex items-center gap-2 p-2 bg-warning-subtle border border-warning rounded-lg text-xs text-warning">
            <span className="text-star text-sm">◆</span>
            {t('task.milestoneHint')}
          </div>
        )}
        <Input
          placeholder={isMilestone ? t('task.milestonePlaceholder') : t('task.titlePlaceholder')}
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
        <Textarea
          placeholder={t('task.descPlaceholder')}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          rows={3}
        />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-fg-muted mb-1 block">{t('common.priority')}</label>
            <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </Select>
          </div>
          <div>
            <label className="text-xs text-fg-muted mb-1 block">{t('common.assignee')}</label>
            <Select value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
              <option value="">{t('common.unassigned')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nickname}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {isMilestone ? (
          <div>
            <label className="text-xs text-fg-muted mb-1 block">{t('task.milestoneDate')}</label>
            <Input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-fg-muted mb-1 block">{t('common.startDate')}</label>
              <Input
                type="date"
                value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-fg-muted mb-1 block">{t('common.dueDate')}</label>
              <Input
                type="date"
                value={form.due_date}
                onChange={(e) => setForm({ ...form, due_date: e.target.value })}
              />
            </div>
          </div>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex gap-2 justify-end pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={saving}>
            {saving ? t('projects.creating') : t('common.create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
