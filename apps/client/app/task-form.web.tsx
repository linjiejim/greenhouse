/**
 * A task's form (`/task-form?project=` new, `&id=` edit), a sheet with a SwiftUI form: the title,
 * then assignee and priority as menu pickers and the due day as a switch with the system date
 * picker. Asking Sprouty is the common way to make tasks; this is the quick, exact one.
 * Behaviour in src/projects/use-task-form.ts; Android: ./task-form.android.tsx.
 */

import React from 'react';
import { DatePicker, Picker, Section, Text, TextField, Toggle, useNativeState } from '../src/ui/form-controls.web';
import { pickerStyle, tag } from '../src/ui/form-controls.web';
import { localDay } from '../src/data/tasks';
import { useT } from '../src/lib/i18n';
import { TASK_PRIORITIES } from '../src/projects/task-draft';
import { useTaskForm } from '../src/projects/use-task-form';
import { EmptyState } from '../src/ui/empty';
import { FormLoading, NativeForm } from '../src/ui/native-form';
import { FormChrome } from '../src/ui/sheet-chrome';

function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : new Date();
}

/** Mounted once the starting title is known: the field owns its text from then on. */
function TitleField({
  initial,
  placeholder,
  onChange,
}: {
  initial: string;
  placeholder: string;
  onChange: (text: string) => void;
}) {
  const state = useNativeState(initial);
  return <TextField text={state} placeholder={placeholder} onTextChange={onChange} autoFocus={!initial} />;
}

export default function TaskForm() {
  const t = useT();
  const form = useTaskForm();
  const { draft, set } = form;
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
        <NativeForm>
          {!form.ready ? (
            <FormLoading />
          ) : (
            <>
              <Section>
                <TitleField
                  initial={draft.title}
                  placeholder={t('projects.taskTitle')}
                  onChange={(text) => set({ title: text })}
                />
              </Section>
              <Section>
                <Picker
                  label={t('projects.assignee')}
                  selection={draft.assigneeId ?? ''}
                  onSelectionChange={(next) => set({ assigneeId: next ? String(next) : null })}
                  modifiers={[pickerStyle('menu')]}
                >
                  <Text modifiers={[tag('')]}>{t('projects.unassigned')}</Text>
                  {form.people.map((person) => (
                    <Text key={person.id} modifiers={[tag(person.id)]}>
                      {person.name}
                    </Text>
                  ))}
                </Picker>
                <Toggle
                  label={t('projects.due')}
                  isOn={!!draft.due}
                  onIsOnChange={(on) => set({ due: on ? (draft.due ?? localDay(new Date())) : null })}
                />
                {draft.due ? (
                  <DatePicker
                    title={t('projects.dueDay')}
                    selection={parseDay(draft.due)}
                    displayedComponents={['date']}
                    onDateChange={(date) => set({ due: localDay(date) })}
                  />
                ) : null}
                <Picker
                  label={t('projects.priorityLabel')}
                  selection={draft.priority}
                  onSelectionChange={(next) => set({ priority: String(next) as typeof draft.priority })}
                  modifiers={[pickerStyle('menu')]}
                >
                  {TASK_PRIORITIES.map((priority) => (
                    <Text key={priority} modifiers={[tag(priority)]}>
                      {t(`projects.priority.${priority}`)}
                    </Text>
                  ))}
                </Picker>
              </Section>
            </>
          )}
        </NativeForm>
      )}
    </>
  );
}
