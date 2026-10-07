/**
 * Project form on Android — create / edit a project as a Material full-screen
 * dialog (iOS: ./project-form.tsx, SwiftUI; behaviour: src/projects/
 * use-project-form.tsx). Outlined name / description fields, status /
 * priority / owner dropdown rows, start + end date rows (Material date
 * picker), the project color palette (tap the selected color again for "no
 * color" = the accent) and visibility (segmented) — owner and visibility only
 * for managers. Chrome is the shared `FormChrome`.
 */

import React from 'react';
import type { Priority, ProjectStatus, ProjectVisibility } from '../../src/api/projects';
import { useT } from '../../src/lib/i18n';
import { OptionalDateField } from '../../src/projects/form-fields.android';
import { PRIORITIES, PROJECT_STATUSES, priorityLabel, projectColorName, projectStatusLabel } from '../../src/projects/meta';
import { ProjectFormGate, useProjectForm, type ProjectFormProps } from '../../src/projects/use-project-form';
import {
  FormFields,
  FormSection,
  FormSegmentedRow,
  FormSelectRow,
  FormSwatchRow,
  FormTextField,
  NativeForm,
  useNativeState,
} from '../../src/ui/native-form.android';
import { FormChrome } from '../../src/ui/sheet-chrome';

export default function ProjectFormScreen() {
  return <ProjectFormGate render={(props) => <ProjectForm {...props} />} />;
}

function ProjectForm(props: ProjectFormProps) {
  const t = useT();
  const { project, canManage } = props;
  const { initial, v, set, setStart, openDate, setOpenDate, dirty, valid, dateOrderBad, saving, save, users, isEdit, ownerMissing, palette, title } =
    useProjectForm(props);
  const titleText = useNativeState(initial.title);
  const descText = useNativeState(initial.description);

  const owners = [
    ...(ownerMissing ? [{ value: v.ownerId, label: project?.owner_nickname ?? v.ownerId }] : []),
    ...users.map((u) => ({ value: u.id, label: u.nickname })),
  ];

  return (
    <>
      <FormChrome title={title} dirty={dirty} canSave={valid && !dateOrderBad} saving={saving} onSave={() => void save()} />
      <NativeForm>
        <FormFields>
          <FormTextField
            label={t('projects.namePlaceholder')}
            state={titleText}
            autoFocus={!isEdit}
            onChangeText={(s) => set('title', s)}
            imeAction="next"
          />
          <FormTextField label={t('projects.descPlaceholder')} state={descText} multiline onChangeText={(s) => set('description', s)} />
        </FormFields>

        <FormSection>
          <FormSelectRow<ProjectStatus>
            label={t('projects.status')}
            icon="statusProgress"
            value={v.status}
            onChange={(s) => set('status', s)}
            options={PROJECT_STATUSES.map((s) => ({ value: s, label: projectStatusLabel(s, t) }))}
          />
          <FormSelectRow<Priority>
            label={t('projects.priority')}
            icon="flag"
            value={v.priority}
            onChange={(p) => set('priority', p)}
            options={PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p, t) }))}
          />
          {canManage ? (
            <FormSelectRow label={t('projects.owner')} icon="crown" value={v.ownerId} onChange={(id) => set('ownerId', id)} options={owners} />
          ) : null}
        </FormSection>

        <FormSection footer={dateOrderBad ? t('projects.dateOrder') : undefined} footerError={dateOrderBad}>
          <OptionalDateField
            label={t('projects.startDate')}
            icon="calendar"
            value={v.start}
            onChange={setStart}
            expanded={openDate === 'start'}
            onExpandedChange={(open) => setOpenDate(open ? 'start' : null)}
          />
          <OptionalDateField
            label={t('projects.endDate')}
            icon="flag"
            value={v.end}
            fallback={v.start}
            min={v.start}
            onChange={(s) => set('end', s)}
            expanded={openDate === 'end'}
            onExpandedChange={(open) => setOpenDate(open ? 'end' : null)}
          />
        </FormSection>

        <FormSection title={t('projects.color')} footer={t('projects.colorHint')}>
          <FormSwatchRow
            colors={palette}
            allowNone
            nameOf={(col) => projectColorName(col, t) ?? t('projects.colorCurrent')}
            value={v.color}
            onChange={(col) => set('color', col)}
          />
        </FormSection>

        {canManage ? (
          <FormSection
            title={t('projects.visibility')}
            footer={v.visibility === 'private' ? t('projects.visibilityPrivateHint') : t('projects.visibilityPublicHint')}
          >
            <FormSegmentedRow<ProjectVisibility>
              label={t('projects.visibility')}
              value={v.visibility}
              onChange={(x) => set('visibility', x)}
              options={[
                { value: 'public', label: t('projects.visibility_public') },
                { value: 'private', label: t('projects.visibility_private') },
              ]}
            />
          </FormSection>
        ) : null}
      </NativeForm>
    </>
  );
}
