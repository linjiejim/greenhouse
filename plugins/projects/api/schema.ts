/**
 * Projects and tasks. Activity on them is written to `audit_events`
 * (app_id = 'projects').
 *
 * Tables: projects, project_members, tasks, task_comments
 */

import { index, integer, pgTable, text, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { at, createdAt, day, id, json, oneOf, updatedAt } from '@greenhouse/api/extension-kit';

export const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed', 'archived'] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const PROJECT_VISIBILITIES = ['public', 'private'] as const;

export const projects = pgTable(
  'projects',
  {
    id: id(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', { enum: PROJECT_STATUSES }).notNull().default('planning'),
    priority: text('priority', { enum: PRIORITIES }).notNull().default('normal'),
    owner_id: text('owner_id').notNull(),
    start_date: day('start_date'),
    end_date: day('end_date'),
    color: text('color'),
    visibility: text('visibility', { enum: PROJECT_VISIBILITIES }).notNull().default('public'),
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    index('idx_projects_status').on(table.status),
    index('idx_projects_owner').on(table.owner_id),
    oneOf('chk_projects_status', table.status, PROJECT_STATUSES),
    oneOf('chk_projects_priority', table.priority, PRIORITIES),
    oneOf('chk_projects_visibility', table.visibility, PROJECT_VISIBILITIES),
  ],
);

export const PROJECT_MEMBER_ROLES = ['owner', 'member'] as const;

export const projectMembers = pgTable(
  'project_members',
  {
    id: id(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    role: text('role', { enum: PROJECT_MEMBER_ROLES }).notNull().default('member'),
    added_by: text('added_by').notNull(),
    created_at: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_project_members_project_user').on(table.project_id, table.user_id),
    index('idx_project_members_user').on(table.user_id),
    oneOf('chk_project_members_role', table.role, PROJECT_MEMBER_ROLES),
  ],
);

export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const;

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parent_id: text('parent_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', { enum: TASK_STATUSES }).notNull().default('todo'),
    priority: text('priority', { enum: PRIORITIES }).notNull().default('normal'),
    task_type: text('task_type').notNull().default('task'),
    assignee_id: text('assignee_id'),
    start_date: day('start_date'),
    due_date: day('due_date'),
    completed_at: at('completed_at'),
    sort_order: integer('sort_order').notNull().default(0),
    estimated_hours: integer('estimated_hours'),
    tags: json<string[]>('tags', []),
    /** Ids of tasks this one waits for. */
    dependencies: json<string[]>('dependencies', []),
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    index('idx_tasks_project').on(table.project_id),
    index('idx_tasks_parent').on(table.parent_id),
    index('idx_tasks_assignee').on(table.assignee_id),
    index('idx_tasks_status').on(table.status),
    oneOf('chk_tasks_status', table.status, TASK_STATUSES),
    oneOf('chk_tasks_priority', table.priority, PRIORITIES),
  ],
);

export const taskComments = pgTable(
  'task_comments',
  {
    id: id(),
    task_id: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    content: text('content').notNull(),
    created_at: createdAt(),
  },
  (table) => [index('idx_task_comments_task').on(table.task_id)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectStatus = ProjectRow['status'];
export type Priority = ProjectRow['priority'];
export type ProjectVisibility = ProjectRow['visibility'];
export type ProjectMemberRow = typeof projectMembers.$inferSelect;
export type ProjectMemberRole = ProjectMemberRow['role'];
export type TaskRow = typeof tasks.$inferSelect;
export type TaskStatus = TaskRow['status'];
export type TaskCommentRow = typeof taskComments.$inferSelect;
