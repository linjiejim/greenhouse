import { sql } from 'drizzle-orm';
import { index, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, jsonOrNull, updatedAt } from './_columns.js';

export type WorkspaceSettings = {
  /** Module defaults for new members. */
  defaultModules?: Record<string, boolean>;
  [key: string]: unknown;
};

/** The workspace: exactly one row, id `default`. Secrets never live here (see providers). */
export const workspace = pgTable('workspace', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default('Greenhouse'),
  logoFileId: text('logo_file_id'),
  primaryColor: text('primary_color'),
  settings: json<WorkspaceSettings>('settings', {}),
  setupCompletedAt: at('setup_completed_at'),
  updatedBy: text('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const JOB_STATUSES = ['pending', 'claimed', 'succeeded', 'failed', 'dead', 'suppressed'] as const;

/**
 * The one background job queue. A job is written in the same transaction as the state
 * change that causes it and claimed with a lease (FOR UPDATE SKIP LOCKED).
 */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key'),
    payload: json<Record<string, unknown>>('payload', {}),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    availableAt: at('available_at').notNull().defaultNow(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: at('lease_expires_at'),
    lastError: text('last_error'),
    result: jsonOrNull<Record<string, unknown>>('result'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('jobs_dedupe_key').on(t.dedupeKey),
    index('jobs_claimable_idx')
      .on(t.availableAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/** Replay protection for side-effecting requests (Idempotency-Key, app actions, Feishu events). */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status', { enum: ['running', 'done'] })
      .notNull()
      .default('running'),
    response: jsonOrNull<unknown>('response'),
    expiresAt: at('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
);

export type WorkspaceRow = typeof workspace.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
