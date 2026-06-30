/**
 * Project service — Project + Task CRUD with activity tracking (PostgreSQL).
 */

import { eq, and, or, like, sql, desc, isNull } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { projects, projectMembers, tasks, taskComments, projectActivities } from '../schema/index.js';
import type {
  ProjectRow,
  ProjectStatus,
  Priority,
  ProjectVisibility,
  ProjectMemberRow,
  ProjectMemberRole,
  TaskRow,
  TaskStatus,
  TaskCommentRow,
  ProjectActivityRow,
} from '../schema/project.js';

export interface ProjectInput {
  title: string;
  description?: string;
  status?: ProjectStatus;
  priority?: Priority;
  owner_id: string;
  start_date?: string;
  end_date?: string;
  color?: string;
  visibility?: ProjectVisibility;
  created_by: string;
}

export interface ProjectUpdateInput {
  title?: string;
  description?: string;
  status?: ProjectStatus;
  priority?: Priority;
  owner_id?: string;
  start_date?: string | null;
  end_date?: string | null;
  color?: string | null;
  visibility?: ProjectVisibility;
}

export interface ProjectMemberInput {
  project_id: number;
  user_id: string;
  role?: ProjectMemberRole;
  added_by: string;
}

export interface TaskInput {
  project_id: number;
  parent_id?: number;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: Priority;
  task_type?: string;
  assignee_id?: string;
  start_date?: string;
  due_date?: string;
  sort_order?: number;
  estimated_hours?: number;
  tags?: string[];
  dependencies?: number[];
  created_by: string;
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: Priority;
  task_type?: string;
  assignee_id?: string | null;
  parent_id?: number | null;
  project_id?: number;
  start_date?: string | null;
  due_date?: string | null;
  sort_order?: number;
  estimated_hours?: number | null;
  tags?: string[];
  dependencies?: number[];
}

export interface TaskCommentInput {
  task_id: number;
  user_id: string;
  content: string;
}

export interface ProjectListOpts {
  status?: ProjectStatus;
  priority?: Priority;
  search?: string;
  limit?: number;
  offset?: number;
  userId?: string;
  userRole?: string;
}

export interface TaskListOpts {
  status?: TaskStatus;
  assignee_id?: string;
  parent_id?: number | null;
  limit?: number;
  offset?: number;
}

export function createProjectService(db: Db) {
  const service = {
    // ── Projects ──

    async createProject(input: ProjectInput): Promise<ProjectRow> {
      const now = nowIso();
      const [inserted] = await db
        .insert(projects)
        .values({
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? 'planning',
          priority: input.priority ?? 'normal',
          owner_id: input.owner_id,
          start_date: input.start_date ?? null,
          end_date: input.end_date ?? null,
          color: input.color ?? null,
          visibility: input.visibility ?? 'public',
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      const project = inserted!;
      // Auto-add creator as owner member
      await db.insert(projectMembers).values({
        project_id: project.id,
        user_id: input.created_by,
        role: 'owner',
        added_by: input.created_by,
        created_at: now,
      });
      // If owner_id differs from creator, add owner as member too
      if (input.owner_id && input.owner_id !== input.created_by) {
        await db
          .insert(projectMembers)
          .values({
            project_id: project.id,
            user_id: input.owner_id,
            role: 'owner',
            added_by: input.created_by,
            created_at: now,
          })
          .onConflictDoNothing();
      }
      await service.logActivityInternal(
        project.id,
        null,
        input.created_by,
        'project_created',
        `创建项目「${input.title}」`,
      );
      return project;
    },

    async getProjectById(id: number): Promise<ProjectRow | undefined> {
      const rows = await db.select().from(projects).where(eq(projects.id, id));
      return rows[0];
    },

    async listProjects(opts?: ProjectListOpts): Promise<ProjectRow[]> {
      const conditions = [];
      if (opts?.status) conditions.push(eq(projects.status, opts.status));
      if (opts?.priority) conditions.push(eq(projects.priority, opts.priority));
      if (opts?.search) {
        const term = `%${opts.search}%`;
        conditions.push(or(like(projects.title, term), like(projects.description, term))!);
      }
      // Visibility filter: super sees all; others see public + own private memberships
      if (opts?.userId && opts?.userRole !== 'super') {
        conditions.push(
          or(
            eq(projects.visibility, 'public'),
            sql`${projects.id} IN (SELECT project_id FROM project_members WHERE user_id = ${opts.userId})`,
          )!,
        );
      }

      const limit = opts?.limit ?? 50;
      const offset = opts?.offset ?? 0;

      let query = db.select().from(projects);
      if (conditions.length > 0) {
        query = query.where(conditions.length === 1 ? conditions[0] : and(...conditions)) as any;
      }
      return await (query as any)
        .orderBy(
          sql`CASE status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 WHEN 'on_hold' THEN 2 WHEN 'completed' THEN 3 WHEN 'archived' THEN 4 END`,
          desc(projects.updated_at),
        )
        .limit(limit)
        .offset(offset);
    },

    async updateProject(id: number, updates: ProjectUpdateInput, userId: string): Promise<ProjectRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      const changes: string[] = [];

      if (updates.title !== undefined) {
        set.title = updates.title;
        changes.push(`标题→「${updates.title}」`);
      }
      if (updates.description !== undefined) {
        set.description = updates.description;
        changes.push('更新描述');
      }
      if (updates.status !== undefined) {
        set.status = updates.status;
        changes.push(`状态→${updates.status}`);
      }
      if (updates.priority !== undefined) {
        set.priority = updates.priority;
        changes.push(`优先级→${updates.priority}`);
      }
      if (updates.owner_id !== undefined) {
        set.owner_id = updates.owner_id;
        changes.push(`负责人→${updates.owner_id}`);
      }
      if (updates.start_date !== undefined) set.start_date = updates.start_date;
      if (updates.end_date !== undefined) set.end_date = updates.end_date;
      if (updates.color !== undefined) set.color = updates.color;
      if (updates.visibility !== undefined) {
        set.visibility = updates.visibility;
        changes.push(`可见性→${updates.visibility}`);
      }

      if (Object.keys(set).length <= 1) return service.getProjectById(id);

      await db.update(projects).set(set).where(eq(projects.id, id));
      if (changes.length > 0) {
        await service.logActivityInternal(id, null, userId, 'project_updated', changes.join('; '));
      }
      return service.getProjectById(id);
    },

    async deleteProject(id: number): Promise<boolean> {
      const deleted = await db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
      return deleted.length > 0;
    },

    async countProjects(opts?: ProjectListOpts): Promise<number> {
      const conditions = [];
      if (opts?.status) conditions.push(eq(projects.status, opts.status));
      if (opts?.priority) conditions.push(eq(projects.priority, opts.priority));
      if (opts?.search) {
        const term = `%${opts.search}%`;
        conditions.push(or(like(projects.title, term), like(projects.description, term))!);
      }
      if (opts?.userId && opts?.userRole !== 'super') {
        conditions.push(
          or(
            eq(projects.visibility, 'public'),
            sql`${projects.id} IN (SELECT project_id FROM project_members WHERE user_id = ${opts.userId})`,
          )!,
        );
      }

      let query = db.select({ cnt: sql<number>`COUNT(*)` }).from(projects);
      if (conditions.length > 0) {
        query = query.where(conditions.length === 1 ? conditions[0] : and(...conditions)) as any;
      }
      const row = (await query)[0];
      return Number(row?.cnt ?? 0);
    },

    async getProjectStats(id: number): Promise<{
      total: number;
      todo: number;
      in_progress: number;
      in_review: number;
      done: number;
      cancelled: number;
    }> {
      const rows = await db
        .select({
          status: tasks.status,
          cnt: sql<number>`COUNT(*)`,
        })
        .from(tasks)
        .where(eq(tasks.project_id, id))
        .groupBy(tasks.status);

      const stats = { total: 0, todo: 0, in_progress: 0, in_review: 0, done: 0, cancelled: 0 };
      for (const row of rows) {
        const key = row.status;
        // postgres.js returns COUNT(*) (bigint) as a string — without Number()
        // these become string concatenations
        const cnt = Number(row.cnt);
        if (key in stats) stats[key] = cnt;
        stats.total += cnt;
      }
      return stats;
    },

    // ── Tasks ──

    async createTask(input: TaskInput): Promise<TaskRow> {
      const now = nowIso();
      let sortOrder = input.sort_order ?? 0;
      if (input.sort_order === undefined) {
        const result = await db.execute(sql`
          SELECT COALESCE(MAX(sort_order), -1) as max_order FROM tasks
          WHERE project_id = ${input.project_id}
          AND ${input.parent_id ? sql`parent_id = ${input.parent_id}` : sql`parent_id IS NULL`}
        `);
        sortOrder = (result as unknown as Array<{ max_order: number }>)[0]!.max_order + 1;
      }

      const [inserted] = await db
        .insert(tasks)
        .values({
          project_id: input.project_id,
          parent_id: input.parent_id ?? null,
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? 'todo',
          priority: input.priority ?? 'normal',
          task_type: input.task_type ?? 'task',
          assignee_id: input.assignee_id ?? null,
          start_date: input.start_date ?? null,
          due_date: input.due_date ?? null,
          sort_order: sortOrder,
          estimated_hours: input.estimated_hours ?? null,
          tags: JSON.stringify(input.tags ?? []),
          dependencies: JSON.stringify(input.dependencies ?? []),
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      const task = inserted!;

      await service.logActivityInternal(
        input.project_id,
        task.id,
        input.created_by,
        'task_created',
        `创建任务「${input.title}」`,
      );
      return task;
    },

    async getTaskById(id: number): Promise<TaskRow | undefined> {
      const rows = await db.select().from(tasks).where(eq(tasks.id, id));
      return rows[0];
    },

    async listTasks(projectId: number, opts?: TaskListOpts): Promise<TaskRow[]> {
      const conditions = [eq(tasks.project_id, projectId)];
      if (opts?.status) conditions.push(eq(tasks.status, opts.status));
      if (opts?.assignee_id) conditions.push(eq(tasks.assignee_id, opts.assignee_id));
      if (opts?.parent_id !== undefined) {
        if (opts.parent_id === null) {
          conditions.push(isNull(tasks.parent_id));
        } else {
          conditions.push(eq(tasks.parent_id, opts.parent_id));
        }
      }

      const limit = opts?.limit ?? 200;
      const offset = opts?.offset ?? 0;

      return await db
        .select()
        .from(tasks)
        .where(and(...conditions))
        .orderBy(tasks.sort_order, tasks.created_at)
        .limit(limit)
        .offset(offset);
    },

    async updateTask(id: number, updates: TaskUpdateInput, userId: string): Promise<TaskRow | undefined> {
      const task = await service.getTaskById(id);
      if (!task) return undefined;

      const set: Record<string, unknown> = { updated_at: nowIso() };
      const changes: string[] = [];

      if (updates.title !== undefined) {
        set.title = updates.title;
        changes.push(`标题→「${updates.title}」`);
      }
      if (updates.description !== undefined) set.description = updates.description;
      if (updates.status !== undefined) {
        set.status = updates.status;
        changes.push(`状态 ${task.status}→${updates.status}`);
        if (updates.status === 'done' && !task.completed_at) {
          set.completed_at = nowIso();
        } else if (updates.status !== 'done') {
          set.completed_at = null;
        }
      }
      if (updates.priority !== undefined) {
        set.priority = updates.priority;
        changes.push(`优先级→${updates.priority}`);
      }
      if (updates.task_type !== undefined) {
        set.task_type = updates.task_type;
        changes.push(`类型→${updates.task_type}`);
      }
      if (updates.assignee_id !== undefined) {
        set.assignee_id = updates.assignee_id;
        changes.push(`指派→${updates.assignee_id || '未分配'}`);
      }
      if (updates.parent_id !== undefined) set.parent_id = updates.parent_id;
      if (updates.project_id !== undefined) {
        set.project_id = updates.project_id;
        changes.push(`移动到项目 #${updates.project_id}`);
      }
      if (updates.start_date !== undefined) set.start_date = updates.start_date;
      if (updates.due_date !== undefined) set.due_date = updates.due_date;
      if (updates.sort_order !== undefined) set.sort_order = updates.sort_order;
      if (updates.estimated_hours !== undefined) set.estimated_hours = updates.estimated_hours;
      if (updates.tags !== undefined) set.tags = JSON.stringify(updates.tags);
      if (updates.dependencies !== undefined) set.dependencies = JSON.stringify(updates.dependencies);

      if (Object.keys(set).length <= 1) return task;

      await db.update(tasks).set(set).where(eq(tasks.id, id));
      if (changes.length > 0) {
        await service.logActivityInternal(task.project_id, id, userId, 'task_updated', changes.join('; '));
      }
      return service.getTaskById(id);
    },

    async deleteTask(id: number): Promise<boolean> {
      const deleted = await db.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id });
      return deleted.length > 0;
    },

    async reorderTasks(updates: Array<{ id: number; sort_order: number }>): Promise<void> {
      await db.transaction(async (tx: any) => {
        for (const u of updates) {
          await tx.update(tasks).set({ sort_order: u.sort_order }).where(eq(tasks.id, u.id));
        }
      });
    },

    async getSubtasks(parentId: number): Promise<TaskRow[]> {
      return await db
        .select()
        .from(tasks)
        .where(eq(tasks.parent_id, parentId))
        .orderBy(tasks.sort_order, tasks.created_at);
    },

    // ── Comments ──

    async addComment(input: TaskCommentInput): Promise<TaskCommentRow> {
      const [inserted] = await db
        .insert(taskComments)
        .values({
          task_id: input.task_id,
          user_id: input.user_id,
          content: input.content,
          created_at: nowIso(),
        })
        .returning();
      const comment = inserted!;

      const task = await service.getTaskById(input.task_id);
      if (task) {
        await service.logActivityInternal(
          task.project_id,
          input.task_id,
          input.user_id,
          'comment_added',
          `在「${task.title}」上添加评论`,
        );
      }
      return comment;
    },

    async getComments(taskId: number, limit = 50): Promise<TaskCommentRow[]> {
      return await db
        .select()
        .from(taskComments)
        .where(eq(taskComments.task_id, taskId))
        .orderBy(taskComments.created_at)
        .limit(limit);
    },

    async deleteComment(id: number): Promise<boolean> {
      const deleted = await db.delete(taskComments).where(eq(taskComments.id, id)).returning({ id: taskComments.id });
      return deleted.length > 0;
    },

    // ── Activity Log ──

    async logActivity(
      projectId: number,
      userId: string,
      action: string,
      taskId?: number,
      detail?: string,
    ): Promise<void> {
      await service.logActivityInternal(projectId, taskId ?? null, userId, action, detail ?? null);
    },

    async getActivities(projectId: number, limit = 50, offset = 0): Promise<ProjectActivityRow[]> {
      return await db
        .select()
        .from(projectActivities)
        .where(eq(projectActivities.project_id, projectId))
        .orderBy(desc(projectActivities.created_at))
        .limit(limit)
        .offset(offset);
    },

    // ── Private ──

    async logActivityInternal(
      projectId: number,
      taskId: number | null,
      userId: string,
      action: string,
      detail: string | null,
    ): Promise<void> {
      await db.insert(projectActivities).values({
        project_id: projectId,
        task_id: taskId,
        user_id: userId,
        action,
        detail,
        created_at: nowIso(),
      });
    },

    // ── Members ──

    async addMember(input: ProjectMemberInput): Promise<ProjectMemberRow> {
      const [inserted] = await db
        .insert(projectMembers)
        .values({
          project_id: input.project_id,
          user_id: input.user_id,
          role: input.role ?? 'member',
          added_by: input.added_by,
          created_at: nowIso(),
        })
        .onConflictDoUpdate({
          target: [projectMembers.project_id, projectMembers.user_id],
          set: { role: input.role ?? 'member', added_by: input.added_by },
        })
        .returning();
      await service.logActivityInternal(
        input.project_id,
        null,
        input.added_by,
        'member_added',
        `添加成员 ${input.user_id}`,
      );
      return inserted!;
    },

    async removeMember(projectId: number, userId: string): Promise<boolean> {
      const deleted = await db
        .delete(projectMembers)
        .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, userId)))
        .returning({ id: projectMembers.id });
      return deleted.length > 0;
    },

    async getMembers(projectId: number): Promise<ProjectMemberRow[]> {
      return await db
        .select()
        .from(projectMembers)
        .where(eq(projectMembers.project_id, projectId))
        .orderBy(projectMembers.created_at);
    },

    async updateMemberRole(
      projectId: number,
      userId: string,
      role: ProjectMemberRole,
    ): Promise<ProjectMemberRow | undefined> {
      const [updated] = await db
        .update(projectMembers)
        .set({ role })
        .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, userId)))
        .returning();
      return updated;
    },

    async isMember(projectId: number, userId: string): Promise<boolean> {
      const rows = await db
        .select({ id: projectMembers.id })
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, userId)))
        .limit(1);
      return rows.length > 0;
    },

    async getUserProjectIds(userId: string): Promise<number[]> {
      const rows = await db
        .select({ project_id: projectMembers.project_id })
        .from(projectMembers)
        .where(eq(projectMembers.user_id, userId));
      return rows.map((r) => r.project_id);
    },
  };
  return service;
}

export type ProjectService = ReturnType<typeof createProjectService>;
