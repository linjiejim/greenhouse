/**
 * The task form (app/task-form.tsx, SwiftUI; ./task-form.android.tsx, Material): a new task in a
 * project (`/task-form?project=`) or an existing one's title, assignee, due day and priority
 * (`/task-form?project=&id=`; status stays the task view's menu). Asking Sprouty in a
 * conversation is the common way to make tasks; this is the quick, exact one. Rules in
 * ./task-draft.ts. Saving closes the sheet; the sheet under it reloads as it comes back.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { createTask, getProject, listAssignableUsers, updateTask } from '../api/projects';
import { noAccess, notFound } from '../data/access';
import { captureIdentity } from '../data/identity';
import { findTask } from '../data/tasks';
import { useResource } from '../data/use-resource';
import { useT } from '../lib/i18n';
import { objectId } from '../lib/object-id';
import { alertError } from '../ui/dialogs';
import { notifySuccess } from '../ui/haptics';
import { toast } from '../ui/toast';
import { EMPTY_DRAFT, canSaveDraft, createBody, draftOf, taskPatch, type TaskDraft } from './task-draft';

export function useTaskForm() {
  const params = useLocalSearchParams<{ project?: string; id?: string }>();
  const projectId = objectId(params.project);
  const taskId = objectId(params.id);
  const editing = taskId != null;
  const t = useT();
  const router = useRouter();
  const users = useResource(listAssignableUsers);
  // an edit starts from the task as its project's tree has it (there is no task-by-id route)
  const project = useResource(useCallback(() => getProject(projectId ?? '0'), [projectId]));
  const task = useMemo(
    () => (editing && project.data ? findTask(project.data.tasks, taskId) : null),
    [editing, project.data, taskId],
  );
  const [initial, setInitial] = useState<TaskDraft | null>(editing ? null : EMPTY_DRAFT);
  const [draft, setDraft] = useState<TaskDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!task || initial) return;
    const start = draftOf(task);
    setInitial(start);
    setDraft(start);
  }, [task, initial]);

  // close once the save cleared the discard guard (dirty turns off on the next render)
  useEffect(() => {
    if (saved) router.back();
  }, [saved, router]);

  const set = useCallback((patch: Partial<TaskDraft>) => setDraft((current) => ({ ...current, ...patch })), []);

  const changes = initial ? taskPatch(initial, draft) : {};
  const dirty =
    !saved &&
    !!initial &&
    (editing ? Object.keys(changes).length > 0 : !!draft.title.trim() || !!draft.assigneeId || !!draft.due || draft.priority !== 'normal');
  const canSave = !!initial && canSaveDraft(draft) && (!editing || dirty);

  // the people to choose from; a current assignee no longer listed (left the team) stays choosable
  const people = useMemo(() => {
    const list = (users.data?.users ?? []).map((user) => ({ id: user.id, name: user.nickname }));
    if (task?.assignee_id && !list.some((user) => user.id === task.assignee_id)) {
      list.unshift({ id: task.assignee_id, name: task.assignee_nickname || task.assignee_id });
    }
    return list;
  }, [users.data, task]);

  const save = async () => {
    if (!canSave || saving || projectId == null) return;
    const current = captureIdentity();
    setSaving(true);
    const result = taskId != null ? await updateTask(taskId, changes) : await createTask(projectId, createBody(draft));
    if (!current()) return;
    setSaving(false);
    if (!result.ok) {
      alertError(t(editing ? 'projects.saveTaskFailed' : 'projects.addTaskFailed'), result.message || undefined);
      return;
    }
    notifySuccess();
    toast(t(editing ? 'projects.taskSaved' : 'projects.taskAdded'), 'check');
    setSaved(true);
  };

  const gone =
    projectId == null ||
    (!project.loading && !project.data && (notFound(project.error) || noAccess(project.error))) ||
    (editing && !!project.data && !task);

  return {
    editing,
    draft,
    set,
    people,
    ready: !!initial,
    failed: !initial && !project.loading && !!project.error && !gone,
    gone,
    retry: () => void project.refresh(),
    saving,
    save,
    dirty,
    canSave,
  };
}
