/**
 * A task's form on Android (Material form; iOS: ./task-form.tsx, behaviour in
 * src/projects/use-task-form.ts). The due day is typed as YYYY-MM-DD.
 */

import React from 'react';
import { useT } from '../src/lib/i18n';
import { TASK_PRIORITIES, validDay } from '../src/projects/task-draft';
import { useTaskForm } from '../src/projects/use-task-form';
import { EmptyState } from '../src/ui/empty';
import {
  FormFields,
  FormLoading,
  FormSection,
  FormSelectRow,
  FormTextField,
  NativeForm,
  useNativeState,
} from '../src/ui/native-form.android';
import { FormChrome } from '../src/ui/sheet-chrome';
import type { TaskPriority } from '../src/shared/greenhouse-types';

function Fields({ form }: { form: ReturnType<typeof useTaskForm> }) {
  const t = useT();
  const { draft, set } = form;
  const titleState = useNativeState(draft.title);
  const dueState = useNativeState(draft.due ?? '');
  return (
    <>
      <FormSection>
        <FormFields>
          <FormTextField label={t('projects.taskTitle')} state={titleState} onChangeText={(text) => set({ title: text })} autoFocus={!draft.title} />
          <FormTextField
            label={t('projects.due')}
            state={dueState}
            placeholder="YYYY-MM-DD"
            onChangeText={(text) => set({ due: text.trim() || null })}
            error={draft.due && !validDay(draft.due) ? t('projects.dueInvalid') : null}
          />
        </FormFields>
      </FormSection>
      <FormSection>
        <FormSelectRow
          label={t('projects.assignee')}
          value={draft.assigneeId ?? ''}
          options={[{ value: '', label: t('projects.unassigned') }, ...form.people.map((person) => ({ value: person.id, label: person.name }))]}
          onChange={(next) => set({ assigneeId: next || null })}
        />
        <FormSelectRow<TaskPriority>
          label={t('projects.priorityLabel')}
          value={draft.priority}
          options={TASK_PRIORITIES.map((priority) => ({ value: priority, label: t(`projects.priority.${priority}`) }))}
          onChange={(next) => set({ priority: next })}
        />
      </FormSection>
    </>
  );
}

export default function TaskForm() {
  const t = useT();
  const form = useTaskForm();
  const title = form.editing ? t('projects.editTask') : t('projects.newTask');

  if (form.gone) {
    return (
      <>
        <FormChrome title={title} dirty={false} canSave={false} onSave={() => {}} hideSave />
        <EmptyState icon="checkCircle" title={form.editing ? t('projects.taskNotFound') : t('projects.notFound')} />
      </>
    );
  }

  return (
    <>
      <FormChrome
        title={title}
        dirty={form.dirty}
        canSave={form.canSave}
        saving={form.saving}
        onSave={() => void form.save()}
        saveLabel={form.editing ? t('common.save') : t('projects.addTask')}
        protectNavigation
      />
      {form.failed ? (
        <EmptyState icon="alert" title={t('projects.loadFailed')} onRetry={form.retry} />
      ) : (
        <NativeForm>{!form.ready ? <FormLoading /> : <Fields form={form} />}</NativeForm>
      )}
    </>
  );
}
