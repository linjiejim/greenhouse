import { z } from 'zod';
import { idParamSchema, pageQuerySchema } from './common.js';
import { cardSchema, filterSchema, recordValuesSchema, roleRulesSchema } from './tables.js';
import type { Base } from './tables.js';

const key = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const title = z.string().trim().min(1).max(100);
export const appActionSchema = z.object({
  id: key,
  name: title,
  type: z.enum(['create', 'update']),
  values: recordValuesSchema,
});
export const appCardSchema = z.union([
  cardSchema,
  z.object({
    id: key,
    kind: z.enum(['records', 'table', 'kanban', 'form']),
    title,
    table_id: idParamSchema,
    fields: z.array(idParamSchema).max(100),
    detail_fields: z.array(idParamSchema).max(100).optional(),
    group_field: idParamSchema.optional(),
    filter: filterSchema.optional(),
    actions: z.array(appActionSchema).max(10).default([]),
  }),
  z.object({ id: key, kind: z.literal('button'), title, table_id: idParamSchema, action: appActionSchema }),
  z.object({
    id: key,
    kind: z.literal('custom'),
    title,
    html: z.string().max(200_000),
    bindings: z
      .array(z.object({ id: key, card: key }))
      .max(10)
      .optional(),
    height: z.number().int().min(100).max(1200).optional(),
  }),
  z.object({
    id: key,
    kind: z.literal('external'),
    title,
    source: z.object({
      connector: z.string().min(1).max(100),
      tool: z.string().min(1).max(200),
      arguments: z.record(z.string(), z.unknown()).default({}),
    }),
    map: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('number'), value: z.string().max(1000) }),
      z.object({
        kind: z.literal('table'),
        rows: z.string().max(1000),
        columns: z
          .array(z.object({ label: title, path: z.string().max(1000) }))
          .min(1)
          .max(20),
      }),
      z.object({
        kind: z.enum(['bar', 'line']),
        rows: z.string().max(1000),
        group: z.string().max(1000),
        value: z.string().max(1000),
      }),
    ]),
  }),
]);
export type AppCard = z.infer<typeof appCardSchema>;
export type AppAction = z.infer<typeof appActionSchema>;
export const appSpecSchema = z
  .object({
    pages: z
      .array(z.object({ id: key.refine((x) => x !== 'edit'), name: title, cards: z.array(appCardSchema).max(30) }))
      .min(1)
      .max(20),
    roles: z
      .array(z.object({ id: key, name: title, rules: roleRulesSchema }))
      .max(20)
      .default([]),
  })
  .superRefine((spec, ctx) => {
    const unique = (ids: string[]) => new Set(ids).size === ids.length;
    if (
      !unique(spec.pages.map((p) => p.id)) ||
      !unique(spec.pages.map((p) => p.name)) ||
      !unique(spec.pages.flatMap((p) => p.cards.map((c) => c.id))) ||
      !unique(spec.roles.map((r) => r.id))
    )
      ctx.addIssue({ code: 'custom', message: 'Page, card and role ids must be unique.' });
  });
export type AppSpec = z.infer<typeof appSpecSchema>;
export const appAudienceSchema = z
  .object({
    principal_type: z.enum(['member', 'group', 'workspace']),
    principal_id: idParamSchema.nullable(),
    role: key,
  })
  .refine((x) => (x.principal_type === 'workspace' ? x.principal_id === null : x.principal_id !== null));
export type AppAudience = z.infer<typeof appAudienceSchema>;
export const appCreateSchema = z.object({
  base_id: idParamSchema,
  name: title,
  description: z.string().max(2000).default(''),
});
export const appDraftSchema = z.object({
  revision: z.number().int().positive(),
  name: title,
  description: z.string().max(2000),
  spec: appSpecSchema,
});
export const appPublishSchema = z.object({
  revision: z.number().int().positive(),
  notes: z.string().max(2000).default(''),
  audience: z.array(appAudienceSchema).max(200),
});
export const appRestoreSchema = z.object({
  revision: z.number().int().positive(),
  version: z.number().int().positive(),
});
export const appListQuerySchema = pageQuerySchema.extend({ q: z.string().trim().max(100).optional() });
export const appRuntimeQuerySchema = z.object({ preview_role: key.optional() });
export const appRequestSchema = z.object({ version: z.number().int().positive() });
export const appExecuteSchema = appRequestSchema.extend({
  card: key,
  action: key,
  record_id: idParamSchema.optional(),
  revision: z.number().int().positive().optional(),
  values: recordValuesSchema.default({}),
});
export const appCardRequestSchema = appRequestSchema.extend({
  version: z.number().int().min(0),
  preview_role: key.optional(),
  card: key,
  cursor: z.string().max(2000).optional(),
});
export const templateSaveSchema = z.object({
  name: title,
  description: z.string().max(2000).default(''),
  changelog: z.string().max(2000).default(''),
});
export const templateReviewSchema = z.object({ decision: z.enum(['approved', 'rejected']) });
export const templateInstallSchema = z.object({ name: title.optional() });
export const appReviewSchema = z.object({
  version: z.number().int().positive(),
  spec_hash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approved', 'rejected']),
});
export const appBindingSchema = appRequestSchema.extend({
  card: key,
  binding: key,
  cursor: z.string().max(2000).optional(),
});
export const appFlagSchema = z.object({ value: z.boolean() });

export interface AppSummary {
  id: string;
  base_id: string;
  name: string;
  description: string;
  owner_id: string;
  status: 'draft' | 'published';
  published_version: number | null;
  editable: boolean;
  pinned: boolean;
  featured: boolean;
}
export interface AppDraft {
  app: AppSummary;
  revision: number;
  spec: AppSpec;
  audience: AppAudience[];
}
export interface AppRuntime {
  app: AppSummary;
  version: number;
  pages: AppSpec['pages'];
  base: Base;
  preview: boolean;
  preview_role: string | null;
  custom_review: 'pending' | 'approved' | 'rejected';
}
export interface AppVersion {
  id: string;
  version: number;
  spec: AppSpec;
  spec_hash: string;
  review_status: 'pending' | 'approved' | 'rejected';
  notes: string;
  published_by: string;
  published_at: string;
}
export interface AppTemplate {
  id: string;
  key: string;
  source: 'builtin' | 'published';
  name: string;
  description: string;
  version: string;
  review_status: 'pending' | 'approved' | 'rejected';
  owner_id: string;
}

/** The Agent and MCP app read faces share the same action contract. */
export const appAgentQuerySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list'),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.object({ action: z.literal('get'), app_id: z.string().max(64) }),
  z.object({
    action: z.literal('query'),
    app_id: z.string().max(64),
    version: z.number().int().positive(),
    card: z.string().max(64),
    cursor: z.string().optional(),
  }),
  z.object({
    action: z.literal('record'),
    app_id: z.string().max(64),
    version: z.number().int().positive(),
    card: z.string().max(64),
    record_id: z.string().max(64),
  }),
]);
