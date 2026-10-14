import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, updatedAt } from './_columns.js';
import { bases, baseTables } from './tables.js';

export const baseAutomations = pgTable(
  'base_automations',
  {
    id: id(),
    baseId: text('base_id')
      .notNull()
      .references(() => bases.id, { onDelete: 'cascade' }),
    tableId: text('table_id')
      .notNull()
      .references(() => baseTables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'paused'] }).notNull(),
    trigger: text('trigger').notNull(),
    config: json<Record<string, unknown>>('config', {}),
    runAs: text('run_as').notNull(),
    secretsEnc: text('secrets_enc'),
    revision: integer('revision').notNull().default(1),
    nextFireAt: at('next_fire_at'),
    sweptUntil: at('swept_until'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('base_automations_table_idx').on(t.tableId),
    index('base_automations_due_idx').on(t.status, t.nextFireAt),
  ],
);
export const baseAutomationRuns = pgTable(
  'base_automation_runs',
  {
    id: id(),
    automationId: text('automation_id')
      .notNull()
      .references(() => baseAutomations.id, { onDelete: 'cascade' }),
    recordId: text('record_id'),
    trigger: text('trigger').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    revision: integer('revision').notNull(),
    status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'suppressed', 'uncertain'] })
      .notNull()
      .default('queued'),
    steps: json<Array<{ index: number; status: string; run_id?: string }>>('steps', []),
    eventChain: json<string[]>('event_chain', []),
    runId: text('run_id'),
    error: text('error'),
    startedAt: at('started_at'),
    finishedAt: at('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('base_automation_runs_dedupe_key').on(t.dedupeKey),
    index('base_automation_runs_automation_idx').on(t.automationId, t.id),
  ],
);
export type BaseAutomationRow = typeof baseAutomations.$inferSelect;
