/**
 * The project form's behaviour, shared by both platforms' views
 * (app/projects/project-form.tsx — SwiftUI, project-form.android.tsx — Material):
 *
 *  - `ProjectFormGate` — the route body: `id` param = edit; waits for the
 *    project (title + ✕ and a spinner / retry meanwhile), works out whether the
 *    user may *manage* it (owner and visibility are manage rights on the
 *    server — owner / creator / super), and renders the platform form with
 *    frozen initial values;
 *  - `useProjectForm` — values, dirty / valid / date-order checks, Calendar
 *    date behaviour (moving start past end drags end along), the color
 *    palette (a current off-palette color leads it so it stays keepable) and
 *    `save` (owner / visibility only sent when a manager changed them; a new
 *    project opens once the form is out of the way).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { createProject, updateProject, type Priority, type Project, type ProjectInput, type ProjectStatus, type ProjectVisibility } from '../api/projects';
import { useT } from '../lib/i18n';
import { useAuth } from '../store/auth';
import { useTheme } from '../theme';
import { alertError } from '../ui/dialogs';
import { EmptyState, LoadingState } from '../ui/empty';
import { SheetClose, useLeaveSheetTo } from '../ui/sheet-chrome';
import { toast } from '../ui/toast';
import { PROJECT_COLORS, projectAccess, toStamp } from './meta';
import { useAssignableUsers, useProjectDetail, useProjects } from './store';

export interface ProjectFormValues {
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

export interface ProjectFormProps {
  project: Project | null;
  canManage: boolean;
  initial: ProjectFormValues;
}

export function ProjectFormGate({ render }: { render: (props: ProjectFormProps) => React.ReactNode }) {
  const t = useT();
  const me = useAuth((s) => s.user);
  const params = useLocalSearchParams<{ id?: string }>();
  const editId = params.id ? Number(params.id) : NaN;
  const isEdit = Number.isFinite(editId);
  const { colors: c } = useTheme();
  const { detail, failed, reload } = useProjectDetail(isEdit ? editId : NaN);

  // Edit needs the project before the (uncontrolled) fields mount; meanwhile
  // (or if it's gone) the form keeps its title + ✕.
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
    <React.Fragment key={project?.id ?? 'new'}>
      {render({ project, canManage, initial: initialValues(project, me?.id ?? '') })}
    </React.Fragment>
  );
}

export function useProjectForm({ project, initial: initialProp }: ProjectFormProps) {
  const t = useT();
  const router = useRouter();
  const leaveTo = useLeaveSheetTo();
  const reload = useProjects((s) => s.reload);
  const users = useAssignableUsers();
  const isEdit = !!project;

  // Frozen at mount: the store may refresh underneath while the form is open.
  const [initial] = useState(initialProp);
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
    // a new project opens once the form is out of the way
    if (isEdit) router.back();
    else leaveTo({ pathname: '/projects/[id]', params: { id: String(saved.id) } });
  }, [valid, dateOrderBad, saving, v, isEdit, initial, project, reload, t, router, leaveTo]);

  const ownerMissing = !!v.ownerId && !users.some((u) => u.id === v.ownerId);
  // keep a current off-palette color pickable (it leads the grid)
  const offPalette = !!initial.color && !PROJECT_COLORS.some((col) => col.toLowerCase() === initial.color!.toLowerCase());
  const palette = offPalette ? [initial.color!, ...PROJECT_COLORS] : PROJECT_COLORS;

  return {
    initial,
    v,
    set,
    setStart,
    openDate,
    setOpenDate,
    dirty,
    valid,
    dateOrderBad,
    saving,
    save,
    users,
    isEdit,
    ownerMissing,
    offPalette,
    palette,
    title: isEdit ? t('projects.editProject') : t('projects.newProject'),
  };
}
