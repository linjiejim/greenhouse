import React from 'react';
import { FilterPills, Input, Select, Textarea } from '../ui';
import { FormField, FormGrid, FormGroup } from '../form';
import { useT } from '../../lib/i18n';

export interface ProjectFormValue {
  title: string;
  description: string;
  status: string;
  priority: string;
  owner_id: string;
  start_date: string;
  end_date: string;
  color: string;
  visibility: 'public' | 'private';
}

export const EMPTY_PROJECT_FORM: ProjectFormValue = {
  title: '',
  description: '',
  status: 'planning',
  priority: 'normal',
  owner_id: '',
  start_date: '',
  end_date: '',
  color: '',
  visibility: 'public',
};

const PROJECT_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899', '#6366f1'];

export function ProjectForm({
  value,
  onChange,
  users = [],
  showStatus = false,
  showOwner = false,
}: {
  value: ProjectFormValue;
  onChange: (value: ProjectFormValue) => void;
  users?: Array<{ id: string; nickname: string }>;
  showStatus?: boolean;
  showOwner?: boolean;
}) {
  const t = useT();
  const set = <K extends keyof ProjectFormValue>(key: K, next: ProjectFormValue[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <div className="space-y-4">
      <FormField label={t('projects.projectName')} required>
        <Input
          data-testid="project-name-input"
          value={value.title}
          onChange={(event) => set('title', event.target.value)}
          placeholder={t('projects.projectNamePlaceholder')}
          autoFocus
        />
      </FormField>
      <FormField label={t('common.description')}>
        <Textarea
          value={value.description}
          onChange={(event) => set('description', event.target.value)}
          placeholder={t('projects.projectDescPlaceholder')}
          rows={3}
        />
      </FormField>

      <FormGrid>
        {showStatus && (
          <FormField label={t('common.status')}>
            <Select value={value.status} onChange={(event) => set('status', event.target.value)}>
              <option value="planning">{t('projects.planning')}</option>
              <option value="active">{t('common.active')}</option>
              <option value="on_hold">{t('projects.onHold')}</option>
              <option value="completed">{t('common.completed')}</option>
              <option value="archived">{t('common.archived')}</option>
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
        {showOwner && (
          <FormField label={t('common.assignee')}>
            <Select value={value.owner_id} onChange={(event) => set('owner_id', event.target.value)}>
              <option value="">{t('common.self')}</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.nickname}
                </option>
              ))}
            </Select>
          </FormField>
        )}
      </FormGrid>

      <FormGrid>
        <FormField label={t('common.startDate')}>
          <Input type="date" value={value.start_date} onChange={(event) => set('start_date', event.target.value)} />
        </FormField>
        <FormField label={t('common.endDate')}>
          <Input type="date" value={value.end_date} onChange={(event) => set('end_date', event.target.value)} />
        </FormField>
      </FormGrid>

      <FormGroup label={t('projects.projectColor')} help={t('projects.projectColorHelp')}>
        <div className="flex min-h-9 flex-wrap items-center gap-2">
          {PROJECT_COLORS.map((color, index) => (
            <button
              key={color}
              type="button"
              aria-label={t('projects.projectColorOption', { index: index + 1 })}
              aria-pressed={value.color === color}
              onClick={() => set('color', value.color === color ? '' : color)}
              className={`h-7 w-7 rounded-full border-2 transition-transform focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:ring-offset-2 focus:ring-offset-surface-raised ${
                value.color === color
                  ? 'scale-110 border-fg'
                  : 'border-transparent hover:scale-105 hover:border-edge-strong'
              }`}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </FormGroup>

      <FormGroup
        label={t('projects.visibility')}
        help={value.visibility === 'private' ? t('projects.visibilityPrivateDesc') : t('projects.visibilityPublicDesc')}
      >
        <FilterPills
          items={[
            { key: 'public', label: t('projects.visibilityPublic') },
            { key: 'private', label: t('projects.visibilityPrivate') },
          ]}
          activeKey={value.visibility}
          onChange={(next) => next && set('visibility', next as ProjectFormValue['visibility'])}
          variant="segment"
          fill
          className="sm:max-w-sm"
        />
      </FormGroup>
    </div>
  );
}
