/**
 * Feedback for the monthly retro: what members asked for and where agents
 * stumbled.
 *
 * Tables: feedback
 *
 * - `kind='request'`: a feature request a member filed (status pending →
 *   accepted / rejected / done).
 * - `kind='friction'`: a team-level "the agent hit a wall here" signal mined
 *   from transcripts or logged live. Never enters a prompt. One row per
 *   `fingerprint` (unique), `occurrence_count` accumulates and
 *   `sample_sessions` keeps the newest five conversation ids (logical
 *   references; telemetry outlives the conversations).
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, oneOf, updatedAt } from './_columns.js';

export const FEEDBACK_KINDS = ['request', 'friction'] as const;
export const REQUEST_STATUSES = ['pending', 'accepted', 'rejected', 'done'] as const;
export const FRICTION_STATUSES = ['new', 'acknowledged', 'resolved', 'archived'] as const;
export const FEEDBACK_STATUSES = [...REQUEST_STATUSES, ...FRICTION_STATUSES] as const;
export const REQUEST_PRIORITIES = ['low', 'normal', 'high'] as const;
export const FRICTION_KINDS = ['tool_error', 'wrong_params', 'detour', 'data_quirk', 'capability_gap'] as const;

export const feedback = pgTable(
  'feedback',
  {
    id: id(),
    kind: text('kind', { enum: FEEDBACK_KINDS }).notNull(),
    /** Request title / friction summary. */
    title: text('title').notNull(),
    /** Request description / friction detail. */
    body: text('body'),
    status: text('status', { enum: FEEDBACK_STATUSES }).notNull(),
    /** Admin note on a request / resolution note on a friction. */
    note: text('note'),
    // ── requests ──
    submitted_by: text('submitted_by'),
    priority: text('priority', { enum: REQUEST_PRIORITIES }),
    session_id: text('session_id'),
    // ── frictions ──
    fingerprint: text('fingerprint'),
    tool_id: text('tool_id'),
    friction_kind: text('friction_kind', { enum: FRICTION_KINDS }),
    occurrence_count: integer('occurrence_count').notNull().default(1),
    sample_sessions: json<string[]>('sample_sessions', []),
    first_seen_at: at('first_seen_at'),
    last_seen_at: at('last_seen_at'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_feedback_fingerprint')
      .on(table.fingerprint)
      .where(sql`${table.fingerprint} IS NOT NULL`),
    index('idx_feedback_kind_status').on(table.kind, table.status, table.updated_at),
    index('idx_feedback_tool').on(table.tool_id),
    oneOf('chk_feedback_kind', table.kind, FEEDBACK_KINDS),
    oneOf('chk_feedback_priority', table.priority, REQUEST_PRIORITIES),
    oneOf('chk_feedback_friction_kind', table.friction_kind, FRICTION_KINDS),
    check(
      'chk_feedback_shape',
      sql`(${table.kind} = 'request' AND ${table.status} IN ('pending', 'accepted', 'rejected', 'done') AND ${table.submitted_by} IS NOT NULL AND ${table.priority} IS NOT NULL AND ${table.fingerprint} IS NULL)
        OR (${table.kind} = 'friction' AND ${table.status} IN ('new', 'acknowledged', 'resolved', 'archived') AND ${table.fingerprint} IS NOT NULL AND ${table.friction_kind} IS NOT NULL AND ${table.first_seen_at} IS NOT NULL AND ${table.last_seen_at} IS NOT NULL)`,
    ),
  ],
);

export type FeedbackRow = typeof feedback.$inferSelect;
