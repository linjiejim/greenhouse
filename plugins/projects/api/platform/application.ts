import { services, type Services } from '../services.js';
/**
 * Projects runtime adapter.
 *
 * HTTP, chat tools, agent proxy, and MCP all dispatch these same actions. The
 * adapter intersects platform entity policy with Projects' public/private and
 * membership rules, preventing transport-specific authorization drift.
 */

import {
  canAccessRecord,
  effectiveUserId,
  resolveEntityPolicy,
  type ActorContext,
  type ApplicationRegistration,
  type EntityPolicy,
  type PlatformActionHandler,
  type PlatformActionResult,
  type PlatformAuditHint,
} from '@greenhouse/api/extension-kit';
import type {
  Priority,
  ProjectMemberRole,
  ProjectRow,
  ProjectStatus,
  ProjectVisibility,
  TaskStatus,
} from '../schema.js';
import type { ProjectListOpts, ProjectUpdateInput, TaskUpdateInput } from '../db-service.js';
import { toRowId } from '@greenhouse/api/extension-kit';
import { projectsManifest } from './manifest.js';
import type { PlatformHandlerContext } from '@greenhouse/api/extension-kit';

export type ProjectActionId = keyof typeof projectsManifest.actions;

type Handler = PlatformActionHandler<PlatformHandlerContext>;

function ok<T>(data: T, audit?: PlatformAuditHint): PlatformActionResult<T> {
  return audit ? { ok: true, data, audit } : { ok: true, data };
}

/**
 * What the audit keeps about a project or task a write created or removed, so
 * the Activity log can still name it (only to viewers who could read it).
 */
function namedRecord(record: { id: string; title: string }, extra: Record<string, unknown> = {}): PlatformAuditHint {
  return { recordId: recordId(record.id), summary: { title: record.title, ...extra } };
}

function fail(
  code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'INTERNAL_ERROR',
  message: string,
): PlatformActionResult {
  return { ok: false, code, message };
}

function recordId(value: string): string {
  return value;
}

async function isActiveInternalUser(context: PlatformHandlerContext, userId: string): Promise<boolean> {
  const user = await context.db.users.getById(userId);
  return !!user && user.status === 'active' && (user.role === 'team' || user.role === 'super');
}

/**
 * Lookups one request may repeat while authorizing many records — the actor's
 * user row, their entity policies, each project and its members. Handlers
 * that check one record pass none; a caller authorizing a batch passes one
 * memo so the same rule runs with each lookup made once.
 */
export interface ProjectAccessMemo {
  user?: ReturnType<PlatformHandlerContext['db']['users']['getById']>;
  policies: Map<string, Promise<EntityPolicy>>;
  projects: Map<string, ReturnType<Services['projects']['getProjectById']>>;
  members: Map<string, ReturnType<Services['projects']['getMembers']>>;
}

export function createProjectAccessMemo(): ProjectAccessMemo {
  return { policies: new Map(), projects: new Map(), members: new Map() };
}

function memoized<K, V>(map: Map<K, V> | undefined, key: K, load: () => V): V {
  if (!map) return load();
  const hit = map.get(key);
  if (hit !== undefined) return hit;
  const value = load();
  map.set(key, value);
  return value;
}

async function entityPolicy(
  context: PlatformHandlerContext,
  actor: ActorContext,
  entityId: string,
  memo?: ProjectAccessMemo,
): Promise<EntityPolicy> {
  return memoized(memo?.policies, entityId, () => loadEntityPolicy(context, actor, entityId));
}

async function loadEntityPolicy(
  context: PlatformHandlerContext,
  actor: ActorContext,
  entityId: string,
): Promise<EntityPolicy> {
  const snapshot = await context.db.platform.getEntityPolicySnapshot({
    orgId: actor.orgId,
    userId: effectiveUserId(actor),
    appId: projectsManifest.id,
    entityId,
  });
  return resolveEntityPolicy(snapshot.rolePolicies, snapshot.userOverride);
}

async function projectAccess(
  context: PlatformHandlerContext,
  actor: ActorContext,
  project: ProjectRow,
  memo?: ProjectAccessMemo,
): Promise<{ readable: boolean; writable: boolean; manageable: boolean; collaboratorIds: string[] }> {
  const userId = effectiveUserId(actor);
  const [user, members, policy] = await Promise.all([
    memo ? (memo.user ??= context.db.users.getById(userId)) : context.db.users.getById(userId),
    memoized(memo?.members, project.id, () => services(context.db).projects.getMembers(project.id)),
    entityPolicy(context, actor, 'project', memo),
  ]);
  if (!user || user.status !== 'active') {
    return { readable: false, writable: false, manageable: false, collaboratorIds: [] };
  }

  const collaboratorIds = members.map((member) => member.user_id);
  const isSuper = user.role === 'super';
  const isMember = collaboratorIds.includes(userId);
  const ownerMember = members.some((member) => member.user_id === userId && member.role === 'owner');
  const entityAllowed = canAccessRecord(
    actor,
    {
      ownerId: project.owner_id,
      collaboratorIds,
    },
    policy,
  );
  const readable = entityAllowed && (isSuper || project.visibility === 'public' || isMember);
  const writable = entityAllowed && (isSuper || isMember);
  const manageable =
    entityAllowed && (isSuper || ownerMember || project.owner_id === userId || project.created_by === userId);
  return { readable, writable, manageable, collaboratorIds };
}

async function findReadableProject(
  context: PlatformHandlerContext,
  actor: ActorContext,
  projectId: string,
): Promise<ProjectRow | undefined> {
  const project = await services(context.db).projects.getProjectById(projectId);
  if (!project) return undefined;
  const access = await projectAccess(context, actor, project);
  return access.readable ? project : undefined;
}

async function findWritableProject(
  context: PlatformHandlerContext,
  actor: ActorContext,
  projectId: string,
  manage = false,
): Promise<ProjectRow | undefined> {
  const project = await services(context.db).projects.getProjectById(projectId);
  if (!project) return undefined;
  const access = await projectAccess(context, actor, project);
  return (manage ? access.manageable : access.writable) ? project : undefined;
}

async function canAccessTask(
  context: PlatformHandlerContext,
  actor: ActorContext,
  task: {
    project_id: string;
    created_by: string;
    assignee_id: string | null;
  },
  mode: 'read' | 'write',
  memo?: ProjectAccessMemo,
): Promise<boolean> {
  const project = await memoized(memo?.projects, task.project_id, () =>
    services(context.db).projects.getProjectById(task.project_id),
  );
  if (!project) return false;
  const access = await projectAccess(context, actor, project, memo);
  if (mode === 'read' ? !access.readable : !access.writable) return false;
  const policy = await entityPolicy(context, actor, 'task', memo);
  return canAccessRecord(
    actor,
    {
      ownerId: task.created_by,
      assigneeId: task.assignee_id,
      collaboratorIds: access.collaboratorIds,
    },
    policy,
  );
}

/**
 * The task read rule (project readability + task entity policy — what listTasks
 * applies to each task) for checking several tasks in one request, with every
 * shared lookup made once. The caller still checks the action capability
 * (`projects.execution.read`), as the kernel does before a handler runs.
 */
export function taskReadAuthorizer(context: PlatformHandlerContext, actor: ActorContext) {
  const memo = createProjectAccessMemo();
  return (task: { project_id: string; created_by: string; assignee_id: string | null }) =>
    canAccessTask(context, actor, task, 'read', memo);
}

/** A row id from the payload; legacy numeric ids are accepted and normalized. */
function idPayload(payload: Record<string, unknown>, key: string): string | undefined {
  return rowId(payload[key]);
}

function rowId(value: unknown): string | undefined {
  return toRowId(value) ?? undefined;
}

/** Normalize the id fields of a task update (legacy numbers → strings); null when one is malformed. */
function normalizeTaskUpdates(raw: TaskUpdateInput): TaskUpdateInput | null {
  const updates: TaskUpdateInput = { ...raw };
  if (raw.project_id !== undefined) {
    const id = rowId(raw.project_id);
    if (!id) return null;
    updates.project_id = id;
  }
  if (raw.parent_id !== undefined && raw.parent_id !== null) {
    const id = rowId(raw.parent_id);
    if (!id) return null;
    updates.parent_id = id;
  }
  if (raw.dependencies !== undefined) {
    const ids = (raw.dependencies as unknown[]).map(rowId);
    if (ids.some((id) => !id)) return null;
    updates.dependencies = ids as string[];
  }
  return updates;
}

const listProjects: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as Partial<ProjectListOpts>;
  const userId = effectiveUserId(request.actor);
  const [user, policy] = await Promise.all([
    context.db.users.getById(userId),
    entityPolicy(context, request.actor, 'project'),
  ]);
  if (!user || user.status !== 'active') return fail('FORBIDDEN', 'User is unavailable');

  const access = {
    userId,
    isSuper: user.role === 'super',
    scopes: policy.scopes.map((scope) => scope.kind),
  };
  const opts: ProjectListOpts = {
    status: payload.status,
    priority: payload.priority,
    search: payload.search,
    limit: payload.limit,
    offset: payload.offset,
    access,
  };
  const [projects, total] = await Promise.all([
    services(context.db).projects.listProjects(opts),
    services(context.db).projects.countProjects(opts),
  ]);
  return ok({ projects, total });
};

const getProject: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as Record<string, unknown>;
  const projectId = idPayload(payload, 'projectId');
  if (!projectId) return fail('INVALID_INPUT', 'projectId is required');
  const project = await findReadableProject(context, request.actor, projectId);
  return project ? ok({ project }) : fail('NOT_FOUND', 'Project not found');
};

const getGantt: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as Partial<ProjectListOpts>;
  return listProjects(
    {
      ...request,
      payload: {
        status: payload.status,
        limit: Math.min(payload.limit ?? 200, 500),
        offset: 0,
      },
    },
    context,
  );
};

const createProject: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as {
    title?: string;
    description?: string;
    status?: ProjectStatus;
    priority?: Priority;
    ownerId?: string;
    startDate?: string;
    endDate?: string;
    color?: string;
    visibility?: ProjectVisibility;
  };
  if (!payload.title?.trim()) return fail('INVALID_INPUT', 'title is required');
  const userId = effectiveUserId(request.actor);
  const ownerId = payload.ownerId || userId;
  if (!(await isActiveInternalUser(context, ownerId))) {
    return fail('INVALID_INPUT', 'Project owner must be an active internal user');
  }
  const project = await services(context.db).projects.createProject({
    title: payload.title.trim(),
    description: payload.description,
    status: payload.status,
    priority: payload.priority,
    owner_id: ownerId,
    start_date: payload.startDate,
    end_date: payload.endDate,
    color: payload.color,
    visibility: payload.visibility,
    created_by: userId,
  });
  return ok({ project }, namedRecord(project, { visibility: project.visibility }));
};

const updateProject: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as {
    projectId?: unknown;
    updates?: ProjectUpdateInput;
  };
  const projectId = rowId(payload.projectId);
  if (!projectId || !payload.updates) return fail('INVALID_INPUT', 'projectId and updates are required');
  const changesProjectControl = payload.updates.owner_id !== undefined || payload.updates.visibility !== undefined;
  const project = await findWritableProject(context, request.actor, projectId, changesProjectControl);
  if (!project) return fail('NOT_FOUND', 'Project not found');
  if (payload.updates.owner_id && !(await isActiveInternalUser(context, payload.updates.owner_id))) {
    return fail('INVALID_INPUT', 'Project owner must be an active internal user');
  }
  const updated = await services(context.db).projects.updateProject(
    project.id,
    payload.updates,
    effectiveUserId(request.actor),
  );
  return updated ? ok({ project: updated }) : fail('NOT_FOUND', 'Project not found');
};

const deleteProject: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as Record<string, unknown>;
  const projectId = idPayload(payload, 'projectId');
  if (!projectId) return fail('INVALID_INPUT', 'projectId is required');
  const project = await findWritableProject(context, request.actor, projectId, true);
  if (!project) return fail('NOT_FOUND', 'Project not found');
  return (await services(context.db).projects.deleteProject(project.id))
    ? ok({ success: true }, namedRecord(project, { visibility: project.visibility }))
    : fail('NOT_FOUND', 'Project not found');
};

const listTasks: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as {
    projectId?: unknown;
    status?: TaskStatus;
    assigneeId?: string;
    limit?: number;
    offset?: number;
  };
  const projectId = rowId(payload.projectId);
  if (!projectId) return fail('INVALID_INPUT', 'projectId is required');
  const project = await findReadableProject(context, request.actor, projectId);
  if (!project) return fail('NOT_FOUND', 'Project not found');
  const tasks = await services(context.db).projects.listTasks(project.id, {
    status: payload.status,
    assignee_id: payload.assigneeId,
    limit: payload.limit,
    offset: payload.offset,
  });
  const allowed: typeof tasks = [];
  for (const task of tasks) {
    if (await canAccessTask(context, request.actor, task, 'read')) allowed.push(task);
  }
  return ok({ tasks: allowed });
};

const createTask: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as {
    projectId?: unknown;
    parentId?: unknown;
    title?: string;
    description?: string;
    status?: TaskStatus;
    priority?: Priority;
    taskType?: string;
    assigneeId?: string;
    startDate?: string;
    dueDate?: string;
    estimatedHours?: number;
    tags?: string[];
    dependencies?: unknown[];
  };
  const projectId = rowId(payload.projectId);
  const parentId = payload.parentId == null || payload.parentId === '' ? undefined : rowId(payload.parentId);
  if (!projectId || !payload.title?.trim()) {
    return fail('INVALID_INPUT', 'projectId and title are required');
  }
  if (payload.parentId != null && payload.parentId !== '' && !parentId) {
    return fail('INVALID_INPUT', 'Parent task is invalid');
  }
  const dependencies = payload.dependencies?.map(rowId);
  if (dependencies?.some((id) => !id)) return fail('INVALID_INPUT', 'dependencies must be task ids');
  const project = await findWritableProject(context, request.actor, projectId);
  if (!project) return fail('NOT_FOUND', 'Project not found');
  if (parentId) {
    const parent = await services(context.db).projects.getTaskById(parentId);
    if (!parent || parent.project_id !== project.id) return fail('INVALID_INPUT', 'Parent task is invalid');
  }
  if (payload.assigneeId && !(await isActiveInternalUser(context, payload.assigneeId))) {
    return fail('INVALID_INPUT', 'Task assignee must be an active internal user');
  }
  const task = await services(context.db).projects.createTask({
    project_id: project.id,
    parent_id: parentId,
    title: payload.title.trim(),
    description: payload.description,
    status: payload.status,
    priority: payload.priority,
    task_type: payload.taskType,
    assignee_id: payload.assigneeId,
    start_date: payload.startDate,
    due_date: payload.dueDate,
    estimated_hours: payload.estimatedHours,
    tags: payload.tags,
    dependencies: dependencies as string[] | undefined,
    created_by: effectiveUserId(request.actor),
  });
  return ok({ task }, namedRecord(task, { project_id: project.id }));
};

const updateTask: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as {
    taskId?: unknown;
    updates?: TaskUpdateInput;
  };
  const taskId = rowId(payload.taskId);
  if (!taskId || !payload.updates) return fail('INVALID_INPUT', 'taskId and updates are required');
  const updates = normalizeTaskUpdates(payload.updates);
  if (!updates) return fail('INVALID_INPUT', 'updates contain an invalid id');
  payload.updates = updates;
  const task = await services(context.db).projects.getTaskById(taskId);
  if (!task || !(await canAccessTask(context, request.actor, task, 'write'))) {
    return fail('NOT_FOUND', 'Task not found');
  }
  if (payload.updates.project_id && payload.updates.project_id !== task.project_id) {
    const target = await findWritableProject(context, request.actor, payload.updates.project_id);
    if (!target) return fail('NOT_FOUND', 'Target project not found');
  }
  if (payload.updates.assignee_id && !(await isActiveInternalUser(context, payload.updates.assignee_id))) {
    return fail('INVALID_INPUT', 'Task assignee must be an active internal user');
  }
  const updated = await services(context.db).projects.updateTask(
    task.id,
    payload.updates,
    effectiveUserId(request.actor),
  );
  return updated ? ok({ task: updated }) : fail('NOT_FOUND', 'Task not found');
};

const deleteTask: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as Record<string, unknown>;
  const taskId = idPayload(payload, 'taskId');
  if (!taskId) return fail('INVALID_INPUT', 'taskId is required');
  const task = await services(context.db).projects.getTaskById(taskId);
  if (!task || !(await canAccessTask(context, request.actor, task, 'write'))) {
    return fail('NOT_FOUND', 'Task not found');
  }
  return (await services(context.db).projects.deleteTask(task.id))
    ? ok({ success: true }, namedRecord(task, { project_id: task.project_id }))
    : fail('NOT_FOUND', 'Task not found');
};

const reorderTasks: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as {
    updates?: Array<{ id: unknown; sortOrder: number; projectId?: unknown }>;
  };
  if (!payload.updates?.length) return fail('INVALID_INPUT', 'updates are required');
  const updates: Array<{ id: string; sortOrder: number; projectId?: string }> = [];
  for (const raw of payload.updates) {
    const id = rowId(raw.id);
    const projectId = raw.projectId == null ? undefined : rowId(raw.projectId);
    if (!id || (raw.projectId != null && !projectId)) return fail('INVALID_INPUT', 'updates contain an invalid id');
    updates.push({ id, sortOrder: raw.sortOrder, projectId });
  }
  for (const update of updates) {
    const task = await services(context.db).projects.getTaskById(update.id);
    if (!task || !(await canAccessTask(context, request.actor, task, 'write'))) {
      return fail('NOT_FOUND', 'Task not found');
    }
    if (update.projectId && update.projectId !== task.project_id) {
      const target = await findWritableProject(context, request.actor, update.projectId);
      if (!target) return fail('NOT_FOUND', 'Target project not found');
      await services(context.db).projects.updateTask(
        task.id,
        { project_id: target.id },
        effectiveUserId(request.actor),
      );
    }
  }
  await services(context.db).projects.reorderTasks(
    updates.map((update) => ({ id: update.id, sort_order: update.sortOrder })),
  );
  return ok({ success: true });
};

const moveTask: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as Record<string, unknown>;
  const taskId = idPayload(payload, 'taskId');
  const projectId = idPayload(payload, 'projectId');
  if (!taskId || !projectId) return fail('INVALID_INPUT', 'taskId and projectId are required');
  const task = await services(context.db).projects.getTaskById(taskId);
  if (!task || !(await canAccessTask(context, request.actor, task, 'write'))) {
    return fail('NOT_FOUND', 'Task not found');
  }
  const target = await findWritableProject(context, request.actor, projectId);
  if (!target) return fail('NOT_FOUND', 'Target project not found');
  const updated = await services(context.db).projects.updateTask(
    task.id,
    { project_id: target.id },
    effectiveUserId(request.actor),
  );
  return updated ? ok({ task: updated }) : fail('NOT_FOUND', 'Task not found');
};

const listComments: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as Record<string, unknown>;
  const taskId = idPayload(payload, 'taskId');
  if (!taskId) return fail('INVALID_INPUT', 'taskId is required');
  const task = await services(context.db).projects.getTaskById(taskId);
  if (!task || !(await canAccessTask(context, request.actor, task, 'read'))) {
    return fail('NOT_FOUND', 'Task not found');
  }
  return ok({ comments: await services(context.db).projects.getComments(task.id) });
};

const addComment: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as { taskId?: unknown; content?: string };
  const taskId = rowId(payload.taskId);
  if (!taskId || !payload.content?.trim()) return fail('INVALID_INPUT', 'taskId and content are required');
  const task = await services(context.db).projects.getTaskById(taskId);
  if (!task || !(await canAccessTask(context, request.actor, task, 'write'))) {
    return fail('NOT_FOUND', 'Task not found');
  }
  const comment = await services(context.db).projects.addComment({
    task_id: task.id,
    user_id: effectiveUserId(request.actor),
    content: payload.content.trim(),
  });
  return ok({ comment });
};

const deleteComment: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as Record<string, unknown>;
  const commentId = idPayload(payload, 'commentId');
  if (!commentId) return fail('INVALID_INPUT', 'commentId is required');
  const comment = await services(context.db).projects.getCommentById(commentId);
  if (!comment) return fail('NOT_FOUND', 'Comment not found');
  const task = await services(context.db).projects.getTaskById(comment.task_id);
  if (!task) return fail('NOT_FOUND', 'Comment not found');
  const project = await services(context.db).projects.getProjectById(task.project_id);
  if (!project) return fail('NOT_FOUND', 'Comment not found');
  const access = await projectAccess(context, request.actor, project);
  const userId = effectiveUserId(request.actor);
  if (!access.writable || (comment.user_id !== userId && !access.manageable)) {
    return fail('NOT_FOUND', 'Comment not found');
  }
  return (await services(context.db).projects.deleteComment(comment.id))
    ? ok({ success: true }, { summary: { task_id: task.id, project_id: task.project_id } })
    : fail('NOT_FOUND', 'Comment not found');
};

const listActivities: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as { projectId?: unknown; limit?: number; offset?: number };
  const projectId = rowId(payload.projectId);
  if (!projectId) return fail('INVALID_INPUT', 'projectId is required');
  const project = await findReadableProject(context, request.actor, projectId);
  if (!project) return fail('NOT_FOUND', 'Project not found');
  return ok({
    activities: await services(context.db).projects.getActivities(project.id, payload.limit, payload.offset),
  });
};

const listMembers: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as Record<string, unknown>;
  const projectId = idPayload(payload, 'projectId');
  if (!projectId) return fail('INVALID_INPUT', 'projectId is required');
  const project = await findReadableProject(context, request.actor, projectId);
  if (!project) return fail('NOT_FOUND', 'Project not found');
  return ok({ members: await services(context.db).projects.getMembers(project.id) });
};

const manageMembers: Handler = async (request, context) => {
  const payload = (request.payload ?? {}) as {
    projectId?: unknown;
    operation?: 'add' | 'update' | 'remove';
    userId?: string;
    role?: ProjectMemberRole;
  };
  const projectId = rowId(payload.projectId);
  if (!projectId || !payload.operation || !payload.userId) {
    return fail('INVALID_INPUT', 'projectId, operation, and userId are required');
  }
  const project = await findWritableProject(context, request.actor, projectId, true);
  if (!project) return fail('NOT_FOUND', 'Project not found');
  if (
    (payload.operation === 'add' || payload.operation === 'update') &&
    !(await isActiveInternalUser(context, payload.userId))
  ) {
    return fail('INVALID_INPUT', 'Project member must be an active internal user');
  }
  if (payload.operation === 'add') {
    const member = await services(context.db).projects.addMember({
      project_id: project.id,
      user_id: payload.userId,
      role: payload.role,
      added_by: effectiveUserId(request.actor),
    });
    return ok({ member });
  }
  if (payload.operation === 'update') {
    if (!payload.role) return fail('INVALID_INPUT', 'role is required');
    const member = await services(context.db).projects.updateMemberRole(project.id, payload.userId, payload.role);
    return member ? ok({ member }) : fail('NOT_FOUND', 'Member not found');
  }
  if (payload.userId === project.owner_id || payload.userId === project.created_by) {
    return fail('CONFLICT', 'Project owner cannot be removed');
  }
  return (await services(context.db).projects.removeMember(project.id, payload.userId))
    ? ok({ success: true })
    : fail('NOT_FOUND', 'Member not found');
};

const listAssignableUsers: Handler = async (_request, context) => {
  const users = await context.db.users.list();
  return ok({
    users: users
      .filter((user) => user.status === 'active' && (user.role === 'team' || user.role === 'super'))
      .map((user) => ({ id: user.id, nickname: user.nickname, role: user.role })),
  });
};

export const projectsRegistration: ApplicationRegistration<PlatformHandlerContext> = {
  manifest: projectsManifest,
  handlers: {
    listProjects,
    getProject,
    getGantt,
    createProject,
    updateProject,
    deleteProject,
    listTasks,
    createTask,
    updateTask,
    deleteTask,
    reorderTasks,
    moveTask,
    listComments,
    addComment,
    deleteComment,
    listActivities,
    listMembers,
    manageMembers,
    listAssignableUsers,
  },
};

export function projectResource(
  actionId: ProjectActionId,
  ids: { projectId?: string | number; taskId?: string | number; commentId?: string | number } = {},
) {
  const action = projectsManifest.actions[actionId];
  const id = ids.commentId ?? ids.taskId ?? ids.projectId;
  return {
    appId: projectsManifest.id,
    moduleId: action.module,
    entityId: action.entity,
    recordId: id != null ? (toRowId(id) ?? undefined) : undefined,
  };
}
