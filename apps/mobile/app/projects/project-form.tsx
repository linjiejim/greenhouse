/**
 * Project form — create / edit a project as a form sheet with a real SwiftUI
 * Form (web parity: the projects page create dialog + project-detail edit).
 * Android: ./project-form.android.tsx; behaviour: src/projects/use-project-form.tsx.
 *
 * Params: `id` (edit). Fields: name (focused on create), description, status
 * and priority menu pickers, owner (menu of assignable users), start / end
 * as Reminders-style date toggles (one inline calendar at a time; moving
 * start past end drags end along, end can't precede start), the project
 * color palette (shared `ColorSwatchPicker`, 4 per row, tap the selected
 * swatch again for "no color" = the accent; a current color from outside
 * the palette — seed / API data — leads the grid so it stays visible and
 * keepable, like a former assignee in the task form) and visibility
 * (segmented).
 * Owner and visibility are *manage* rights on the server (owner / creator /
 * super), so they're only shown — and only sent when changed — to managers.
 * Chrome is the shared `FormChrome`: ✓ saves (disabled until named and the
 * dates are in order), refreshes, toasts and dismisses (a new project then
 * opens via `useLeaveSheetTo`); a failed save is a system alert and the sheet
 * stays open; ✕ asks before discarding edits. While an edited project loads
 * (or if it's gone) the sheet keeps title + ✕.
 */

import React from 'react';
import { Picker, Section, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import { foregroundStyle, lineLimit, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import type { Priority, ProjectStatus, ProjectVisibility } from '../../src/api/projects';
import { useT } from '../../src/lib/i18n';
import { OptionalDateField } from '../../src/projects/form-fields';
import { PRIORITIES, PROJECT_STATUSES, priorityLabel, projectColorName, projectStatusLabel } from '../../src/projects/meta';
import { ProjectFormGate, useProjectForm, type ProjectFormProps } from '../../src/projects/use-project-form';
import { ColorSwatchPicker, NativeForm } from '../../src/ui/native-form';
import { FormChrome } from '../../src/ui/sheet-chrome';

export default function ProjectFormScreen() {
  return <ProjectFormGate render={(props) => <ProjectForm {...props} />} />;
}

function ProjectForm(props: ProjectFormProps) {
  const t = useT();
  const { project, canManage } = props;
  const { initial, v, set, setStart, openDate, setOpenDate, dirty, valid, dateOrderBad, saving, save, users, isEdit, ownerMissing, offPalette, palette } =
    useProjectForm(props);
  const titleText = useNativeState(initial.title);
  const descText = useNativeState(initial.description);

  return (
    <>
      <FormChrome
        title={isEdit ? t('projects.editProject') : t('projects.newProject')}
        dirty={dirty}
        canSave={valid && !dateOrderBad}
        saving={saving}
        onSave={() => void save()}
      />
      <NativeForm>
        <Section>
          <TextField text={titleText} autoFocus={!isEdit} placeholder={t('projects.namePlaceholder')} onTextChange={(s) => set('title', s)} />
          <TextField
            text={descText}
            axis="vertical"
            placeholder={t('projects.descPlaceholder')}
            onTextChange={(s) => set('description', s)}
            modifiers={[lineLimit({ min: 2, max: 8 })]}
          />
        </Section>

        <Section>
          <Picker
            label={t('projects.status')}
            systemImage="circle.lefthalf.filled"
            selection={v.status}
            onSelectionChange={(s) => set('status', s as ProjectStatus)}
            modifiers={[pickerStyle('menu')]}
          >
            {PROJECT_STATUSES.map((s) => (
              <Text key={s} modifiers={[tag(s)]}>
                {projectStatusLabel(s, t)}
              </Text>
            ))}
          </Picker>
          <Picker
            label={t('projects.priority')}
            systemImage="flag"
            selection={v.priority}
            onSelectionChange={(p) => set('priority', p as Priority)}
            modifiers={[pickerStyle('menu')]}
          >
            {PRIORITIES.map((p) => (
              <Text key={p} modifiers={[tag(p)]}>
                {priorityLabel(p, t)}
              </Text>
            ))}
          </Picker>
          {canManage ? (
            <Picker
              label={t('projects.owner')}
              systemImage="crown"
              selection={v.ownerId}
              onSelectionChange={(id) => set('ownerId', String(id ?? ''))}
              modifiers={[pickerStyle('menu')]}
            >
              {ownerMissing ? <Text modifiers={[tag(v.ownerId)]}>{project?.owner_nickname ?? v.ownerId}</Text> : null}
              {users.map((u) => (
                <Text key={u.id} modifiers={[tag(u.id)]}>
                  {u.nickname}
                </Text>
              ))}
            </Picker>
          ) : null}
        </Section>

        <Section footer={dateOrderBad ? <Text modifiers={[foregroundStyle('red')]}>{t('projects.dateOrder')}</Text> : undefined}>
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
            icon="flag.checkered"
            value={v.end}
            fallback={v.start}
            min={v.start}
            onChange={(s) => set('end', s)}
            expanded={openDate === 'end'}
            onExpandedChange={(open) => setOpenDate(open ? 'end' : null)}
          />
        </Section>

        <Section title={t('projects.color')} footer={<Text>{t('projects.colorHint')}</Text>}>
          <ColorSwatchPicker
            colors={palette}
            perRow={offPalette ? 5 : 4}
            allowNone
            nameOf={(col) => projectColorName(col, t) ?? t('projects.colorCurrent')}
            value={v.color}
            onChange={(col) => set('color', col)}
          />
        </Section>

        {canManage ? (
          <Section
            title={t('projects.visibility')}
            footer={<Text>{v.visibility === 'private' ? t('projects.visibilityPrivateHint') : t('projects.visibilityPublicHint')}</Text>}
          >
            <Picker
              selection={v.visibility}
              onSelectionChange={(x) => set('visibility', x as ProjectVisibility)}
              modifiers={[pickerStyle('segmented')]}
            >
              <Text modifiers={[tag('public')]}>{t('projects.visibility_public')}</Text>
              <Text modifiers={[tag('private')]}>{t('projects.visibility_private')}</Text>
            </Picker>
          </Section>
        ) : null}
      </NativeForm>
    </>
  );
}
