/**
 * Project form — create / edit a project as a form sheet with a real SwiftUI
 * Form (web parity: the projects page create dialog + project-detail edit).
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

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Picker, Section, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import { foregroundStyle, lineLimit, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { createProject, updateProject, type Priority, type Project, type ProjectInput, type ProjectStatus, type ProjectVisibility } from '../../src/api/projects';
import { useT } from '../../src/lib/i18n';
import { useAuth } from '../../src/store/auth';
import { OptionalDateField } from '../../src/projects/form-fields';
import {
  PRIORITIES,
  PROJECT_COLORS,
  PROJECT_STATUSES,
  priorityLabel,
  projectAccess,
  projectColorName,
  projectStatusLabel,
  toStamp,
} from '../../src/projects/meta';
import { useAssignableUsers, useProjectDetail, useProjects } from '../../src/projects/store';
import { useTheme } from '../../src/theme';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ColorSwatchPicker, NativeForm } from '../../src/ui/native-form';
import { FormChrome, SheetClose, useLeaveSheetTo } from '../../src/ui/sheet-chrome';
import { toast } from '../../src/ui/toast';

interface ProjectFormValues {
  title: string;
  description: string;
  status: ProjectStatus;
  priority: Priority;
  ownerId: string;
  start: string | null;
  end: string | null;
  color: string | null;
  visibility: ProjectVisibility;
}

function initialValues(project: Project | null, meId: string): ProjectFormValues {
  return {
    title: project?.title ?? '',
    description: project?.description ?? '',
    status: project?.status ?? 'planning',
    priority: project?.priority ?? 'normal',
    ownerId: project?.owner_id ?? meId,
    start: toStamp(project?.start_date),
    end: toStamp(project?.end_date),
    color: project?.color ?? null,
    visibility: project?.visibility ?? 'public',
  };
}

export default function ProjectFormScreen() {
  const t = useT();
  const me = useAuth((s) => s.user);
  const params = useLocalSearchParams<{ id?: string }>();
  const editId = params.id ? Number(params.id) : NaN;
  const isEdit = Number.isFinite(editId);
  const { colors: c } = useTheme();
  const { detail, failed, reload } = useProjectDetail(isEdit ? editId : NaN);

  // Edit needs the project before the (uncontrolled) fields mount; meanwhile
  // (or if it's gone) the sheet keeps its title + ✕.
  if (isEdit && !detail) {
    return (
      <>
        <Stack.Screen options={{ title: t('projects.editProject') }} />
        <SheetClose />
        <View style={{ flex: 1, justifyContent: 'center', backgroundColor: c.groupedBackground }}>
          {failed ? (
            <EmptyState
              icon="alert"
              title={t('projects.projectMissing')}
              message={t('projects.projectMissingHint')}
              onRetry={() => void reload()}
            />
          ) : (
            <LoadingState />
          )}
        </View>
      </>
    );
  }

  const project = detail?.project ?? null;
  const canManage = project ? projectAccess(project, detail?.members, me).canManage : true;
  return (
    <ProjectForm key={project?.id ?? 'new'} project={project} canManage={canManage} initial={initialValues(project, me?.id ?? '')} />
  );
}

function ProjectForm({
  project,
  canManage,
  initial: initialProp,
}: {
  project: Project | null;
  canManage: boolean;
  initial: ProjectFormValues;
}) {
  const t = useT();
  const router = useRouter();
  const leaveTo = useLeaveSheetTo();
  const reload = useProjects((s) => s.reload);
  const users = useAssignableUsers();
  const isEdit = !!project;

  const [initial] = useState(initialProp);
  const titleText = useNativeState(initial.title);
  const descText = useNativeState(initial.description);
  const [v, setV] = useState<ProjectFormValues>(initial);
  const [saving, setSaving] = useState(false);
  const [openDate, setOpenDate] = useState<'start' | 'end' | null>(null);
  const set = useCallback(<K extends keyof ProjectFormValues>(k: K, val: ProjectFormValues[K]) => setV((p) => ({ ...p, [k]: val })), []);
  // Calendar behaviour: moving start past end drags end along.
  const setStart = useCallback(
    (s: string | null) => setV((p) => ({ ...p, start: s, end: s && p.end && p.end < s ? s : p.end })),
    [],
  );

  const dirty = useMemo(() => (Object.keys(initial) as (keyof ProjectFormValues)[]).some((k) => initial[k] !== v[k]), [initial, v]);
  const valid = v.title.trim().length > 0;
  const dateOrderBad = !!v.start && !!v.end && v.start > v.end;

  const save = useCallback(async () => {
    if (!valid || dateOrderBad || saving) return;
    setSaving(true);
    const body: ProjectInput = {
      title: v.title.trim(),
      description: isEdit ? v.description.trim() : v.description.trim() || undefined,
      status: v.status,
      priority: v.priority,
      start_date: v.start,
      end_date: v.end,
      color: v.color,
    };
    // manage-only fields: send on create, or when a manager changed them
    if (!isEdit || v.ownerId !== initial.ownerId) body.owner_id = v.ownerId || undefined;
    if (!isEdit || v.visibility !== initial.visibility) body.visibility = v.visibility;

    const saved = isEdit ? await updateProject(project!.id, body) : await createProject({ ...body, title: body.title! });
    if (!saved) {
      setSaving(false);
      alertError(t('projects.saveFailed'));
      return;
    }
    await reload(saved.id, { fresh: true });
    toast(isEdit ? t('projects.saved') : t('projects.projectCreated'), 'checkCircle');
    // a new project opens once the sheet is out of the way
    if (isEdit) router.back();
    else leaveTo({ pathname: '/projects/[id]', params: { id: String(saved.id) } });
  }, [valid, dateOrderBad, saving, v, isEdit, initial, project, reload, t, router, leaveTo]);

  const ownerMissing = !!v.ownerId && !users.some((u) => u.id === v.ownerId);
  // keep a current off-palette color pickable (5 + 4 grid instead of 4 + 4)
  const offPalette = !!initial.color && !PROJECT_COLORS.some((col) => col.toLowerCase() === initial.color!.toLowerCase());
  const palette = offPalette ? [initial.color!, ...PROJECT_COLORS] : PROJECT_COLORS;

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
