import { boolean, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { at, createdAt, json, jsonOrNull, updatedAt } from './_columns.js';
import { members } from './identity.js';

export const CAPABILITIES = [
  'llm',
  'stt',
  'tts',
  'image',
  'video',
  'sandbox',
  'search',
  'storage',
  'mail',
  'im',
  'push',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type ProviderCheck = { at: string; ok: boolean; latencyMs?: number; error?: string };

/**
 * Provider instances configured at runtime. Instances from env vars live only in memory.
 * `secretsEnc` is write-only: no read path returns it.
 */
export const providers = pgTable(
  'providers',
  {
    /** Readable slug, because model references are written `instance/model`. */
    id: text('id').primaryKey(),
    capability: text('capability', { enum: CAPABILITIES }).notNull(),
    kind: text('kind').notNull(),
    preset: text('preset'),
    name: text('name').notNull(),
    scope: text('scope', { enum: ['workspace', 'personal'] })
      .notNull()
      .default('workspace'),
    ownerId: text('owner_id').references(() => members.id, { onDelete: 'cascade' }),
    config: json<Record<string, unknown>>('config', {}),
    secretsEnc: text('secrets_enc'),
    enabled: boolean('enabled').notNull().default(true),
    lastCheck: jsonOrNull<ProviderCheck>('last_check'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('providers_capability_idx').on(t.capability), index('providers_owner_idx').on(t.ownerId)],
);

export type ProviderPolicy = { allowPersonal?: boolean; personalCountsTowardBudget?: boolean };

/** Which instances serve a capability, in fallback order, plus its defaults and policy. */
export const providerBindings = pgTable('provider_bindings', {
  capability: text('capability', { enum: CAPABILITIES }).primaryKey(),
  instanceIds: json<string[]>('instance_ids', []),
  defaults: json<Record<string, unknown>>('defaults', {}),
  policy: json<ProviderPolicy>('policy', {}),
  /** Resolution caches compare it. */
  version: integer('version').notNull().default(0),
  updatedBy: text('updated_by'),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

export type ProviderRow = typeof providers.$inferSelect;
export type NewProviderRow = typeof providers.$inferInsert;
export type ProviderBindingRow = typeof providerBindings.$inferSelect;
