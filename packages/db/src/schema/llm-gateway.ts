/**
 * Drizzle schema — LLM Gateway (团队模型中转网关) tables (PostgreSQL).
 *
 * Tables:
 * - llm_upstreams        上游池：真实厂商 endpoint + 加密 key（管理员维护）
 * - llm_gateway_models   对外模型目录：用户可选的 public 模型 → 上游映射
 *
 * 中转 key 本身复用 `api_clients`（channel='relay'，meta.allowed_models 限定子集），
 * 不在这里建表。
 */

import { pgTable, text, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';

// ─── llm_upstreams ────────────────────────────────────────

export const llmUpstreams = pgTable('llm_upstreams', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // 决定服务端转发/翻译方式
  provider_kind: text('provider_kind', { enum: ['openai', 'anthropic', 'deepseek', 'openai-compatible'] }).notNull(),
  base_url: text('base_url').notNull(),
  // 组织真实 key，AES-256-GCM 加密（复用 PROVIDER_TOKEN_ENCRYPTION_KEY）
  api_key_enc: text('api_key_enc').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  created_by: text('created_by'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});

// ─── llm_gateway_models ───────────────────────────────────

export const llmGatewayModels = pgTable(
  'llm_gateway_models',
  {
    id: text('id').primaryKey(),
    // 用户在 Desktop 看到/请求的 model id（OpenAI `model` 字段），全局唯一
    public_id: text('public_id').notNull().unique(),
    display_name: text('display_name').notNull(),
    // 域内强所有权：上游删除时级联删除其模型目录
    upstream_id: text('upstream_id')
      .notNull()
      .references(() => llmUpstreams.id, { onDelete: 'cascade' }),
    // 真正发给上游的 model id
    upstream_model: text('upstream_model').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // 无感默认接入时选中的模型（最多一个生效，应用层保证）
    is_default: boolean('is_default').notNull().default(false),
    // 是否进入"默认可用子集"（自动签发 key 默认能用的模型集合）
    is_public: boolean('is_public').notNull().default(true),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_gateway_models_upstream').on(table.upstream_id)],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type LlmUpstreamRow = typeof llmUpstreams.$inferSelect;
export type LlmUpstreamKind = LlmUpstreamRow['provider_kind'];
export type LlmGatewayModelRow = typeof llmGatewayModels.$inferSelect;
