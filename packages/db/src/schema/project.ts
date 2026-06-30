/**
 * Drizzle schema — Project management tables (PostgreSQL).
 *
 * Tables: projects, project_members, tasks, task_comments, project_activities
 */

import { pgTable, text, serial, timestamp, integer, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';

// ─── projects ─────────────────────────────────────────────

export const projects = pgTable(
  'projects',
  {
    id: serial('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', { enum: ['planning', 'active', 'on_hold', 'completed', 'archived'] })
      .notNull()
      .default('planning'),
    priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] })
      .notNull()
      .default('normal'),
    owner_id: text('owner_id').notNull(),
    start_date: text('start_date'),
    end_date: text('end_date'),
    color: text('color'),
    visibility: text('visibility', { enum: ['public', 'private'] })
      .notNull()
      .default('public'),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_projects_status').on(table.status), index('idx_projects_owner').on(table.owner_id)],
);

// ─── project_members ──────────────────────────────────────

export const projectMembers = pgTable(
  'project_members',
  {
    id: serial('id').primaryKey(),
    project_id: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    role: text('role', { enum: ['owner', 'member'] })
      .notNull()
      .default('member'),
    added_by: text('added_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('idx_project_members_unique').on(table.project_id, table.user_id),
    index('idx_project_members_user').on(table.user_id),
  ],
);

// ─── tasks ────────────────────────────────────────────────

export const tasks = pgTable(
  'tasks',
  {
    id: serial('id').primaryKey(),
    project_id: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parent_id: integer('parent_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', { enum: ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] })
      .notNull()
      .default('todo'),
    // NOTE: literals must stay identical to projects.priority (shared `Priority` union)
    priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] })
      .notNull()
      .default('normal'),
    task_type: text('task_type').notNull().default('task'),
    assignee_id: text('assignee_id'),
    start_date: text('start_date'),
    due_date: text('due_date'),
    completed_at: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
    sort_order: integer('sort_order').notNull().default(0),
    estimated_hours: integer('estimated_hours'),
    tags: text('tags').notNull().default('[]'),
    dependencies: text('dependencies').notNull().default('[]'),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_tasks_project').on(table.project_id),
    index('idx_tasks_parent').on(table.parent_id),
    index('idx_tasks_assignee').on(table.assignee_id),
    index('idx_tasks_status').on(table.status),
  ],
);

// ─── task_comments ────────────────────────────────────────

export const taskComments = pgTable(
  'task_comments',
  {
    id: serial('id').primaryKey(),
    task_id: integer('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    content: text('content').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_task_comments_task').on(table.task_id)],
);

// ─── project_activities ───────────────────────────────────

export const projectActivities = pgTable(
  'project_activities',
  {
    id: serial('id').primaryKey(),
    project_id: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    task_id: integer('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    user_id: text('user_id').notNull(),
    action: text('action').notNull(),
    detail: text('detail'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_project_activities_project').on(table.project_id)],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectStatus = ProjectRow['status'];
export type Priority = ProjectRow['priority'];
export type ProjectVisibility = ProjectRow['visibility'];
export type ProjectMemberRow = typeof projectMembers.$inferSelect;
export type ProjectMemberRole = ProjectMemberRow['role'];
export type TaskRow = typeof tasks.$inferSelect;
export type TaskStatus = TaskRow['status'];
export type TaskCommentRow = typeof taskComments.$inferSelect;
export type ProjectActivityRow = typeof projectActivities.$inferSelect;
