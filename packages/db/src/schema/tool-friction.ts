/**
 * Drizzle schema — Tool frictions (PostgreSQL).
 *
 * Tables: tool_frictions
 *
 * Where the agent's stumbles are collected so a human can fix them at the
 * harness layer (tool description, tool implementation, profile prompt, skill,
 * code). Deliberately NOT a shared memory: nothing here is ever injected into a
 * prompt — it is a review queue, see docs/specs/20260804-memory-v2.md.
 *
 * Two writers, one row per `fingerprint`:
 *   • the daily miner, which aggregates tool errors out of messages.pipeline
 *   • the `log_friction` tool, for detours that never produced an error
 *
 * Team-wide (no user_id): the same wrong turn costs everyone, and the count is
 * the priority signal. Session ids are kept for traceback only, with no FK —
 * this is operational telemetry and must outlive the sessions it came from.
 */

import { pgTable, serial, text, timestamp, integer, index } from 'drizzle-orm/pg-core';

// ─── tool_frictions ───────────────────────────────────────

export const toolFrictions = pgTable(
  'tool_frictions',
  {
    id: serial('id').primaryKey(),
    /** Aggregation key — same stumble, same row. Derived from tool + kind + normalised summary. */
    fingerprint: text('fingerprint').notNull().unique(),
    /** Tool that stumbled; null for frictions that aren't tied to one (e.g. data quirks). */
    tool_id: text('tool_id'),
    kind: text('kind', {
      enum: ['tool_error', 'wrong_params', 'detour', 'data_quirk', 'capability_gap'],
    }).notNull(),
    summary: text('summary').notNull(),
    /** Redacted evidence sample (raw input/error excerpt). Verbatim — never translated. */
    detail: text('detail'),
    occurrence_count: integer('occurrence_count').notNull().default(1),
    /** JSON array of up to 5 session ids for traceback (logical reference, no FK). */
    sample_sessions: text('sample_sessions').notNull().default('[]'),
    status: text('status', { enum: ['new', 'acknowledged', 'resolved', 'archived'] })
      .notNull()
      .default('new'),
    resolution_note: text('resolution_note'),
    first_seen_at: timestamp('first_seen_at', { withTimezone: true, mode: 'string' }).notNull(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_tool_frictions_status').on(table.status, table.last_seen_at),
    index('idx_tool_frictions_tool').on(table.tool_id),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type ToolFrictionRow = typeof toolFrictions.$inferSelect;
export type ToolFrictionKind = ToolFrictionRow['kind'];
export type ToolFrictionStatus = ToolFrictionRow['status'];
