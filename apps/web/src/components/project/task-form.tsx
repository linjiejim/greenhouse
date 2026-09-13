import React from 'react';
import { Input, Select, Textarea } from '../ui';
import { FormField, FormGrid } from '../form';
import { useT } from '../../lib/i18n';

export interface TaskFormValue {
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee_id: string;
  start_date: string;
  due_date: string;
  estimated_hours: string;
  tags: string;
  dependencies: number[];
}

export const EMPTY_TASK_FORM: TaskFormValue = {
  title: '',
  description: '',
  status: 'todo',
  priority: 'normal',
  assignee_id: '',
  start_date: '',
  due_date: '',
  estimated_hours: '',
  tags: '',
  dependencies: [],
};

export function TaskForm({
  value,
  onChange,
  users,
  isMilestone = false,
  showStatus = false,
  showTags = false,
}: {
  value: TaskFormValue;
  onChange: (value: TaskFormValue) => void;
  users: Array<{ id: string; nickname: string }>;
  isMilestone?: boolean;
  showStatus?: boolean;
  showTags?: boolean;
}) {
  const t = useT();
  const set = <K extends keyof TaskFormValue>(key: K, next: TaskFormValue[K]) => onChange({ ...value, [key]: next });

  return (
    <div className="space-y-4">
      <FormField label={isMilestone ? t('task.milestoneName') : t('task.taskTitleLabel')} required>
        <Input
          value={value.title}
          onChange={(event) => set('title', event.target.value)}
          placeholder={isMilestone ? t('task.milestonePlaceholder') : t('task.titlePlaceholder')}
          autoFocus
        />
      </FormField>
      <FormField label={t('common.description')}>
        <Textarea
          value={value.description}
          onChange={(event) => set('description', event.target.value)}
          placeholder={t('task.descPlaceholder')}
          rows={4}
        />
      </FormField>

      <FormGrid>
        {showStatus && (
          <FormField label={t('common.status')}>
            <Select value={value.status} onChange={(event) => set('status', event.target.value)}>
              <option value="todo">{t('projects.todo')}</option>
              <option value="in_progress">{t('projects.inProgress')}</option>
              <option value="in_review">{t('projects.inReview')}</option>
              <option value="done">{t('common.done')}</option>
              <option value="cancelled">{t('common.cancelled')}</option>
            </Select>
          </FormField>
        )}
        <FormField label={t('common.priority')}>
          <Select value={value.priority} onChange={(event) => set('priority', event.target.value)}>
            <option value="low">{t('common.low')}</option>
            <option value="normal">{t('common.normal')}</option>
            <option value="high">{t('common.high')}</option>
            <option value="urgent">{t('common.urgent')}</option>
          </Select>
        </FormField>
        <FormField label={t('common.assignee')}>
          <Select value={value.assignee_id} onChange={(event) => set('assignee_id', event.target.value)}>
            <option value="">{t('common.unassigned')}</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.nickname}
              </option>
            ))}
          </Select>
        </FormField>
      </FormGrid>

      {isMilestone ? (
        <FormField label={t('task.milestoneDate')}>
          <Input type="date" value={value.due_date} onChange={(event) => set('due_date', event.target.value)} />
        </FormField>
      ) : (
        <FormGrid>
          <FormField label={t('common.startDate')}>
            <Input type="date" value={value.start_date} onChange={(event) => set('start_date', event.target.value)} />
          </FormField>
          <FormField label={t('common.dueDate')}>
            <Input type="date" value={value.due_date} onChange={(event) => set('due_date', event.target.value)} />
          </FormField>
        </FormGrid>
      )}

      {!isMilestone && (
        <FormGrid>
          <FormField label={t('task.estimatedHours')} help={t('task.estimatedHoursHelp')}>
            <Input
              type="number"
              min={0}
              value={value.estimated_hours}
              onChange={(event) => set('estimated_hours', event.target.value)}
            />
          </FormField>
          {showTags && (
            <FormField label={t('task.tagsComma')} help={t('task.tagsHelp')}>
              <Input
                value={value.tags}
                onChange={(event) => set('tags', event.target.value)}
                placeholder={t('task.tagsPlaceholder')}
              />
            </FormField>
          )}
        </FormGrid>
      )}
    </div>
  );
}
