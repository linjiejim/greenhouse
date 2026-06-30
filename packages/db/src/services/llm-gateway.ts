/**
 * LLM Gateway services (PostgreSQL).
 *
 * - createLlmUpstreamService      上游池
 * - createLlmGatewayModelService  对外模型目录
 */

import { randomUUID } from 'node:crypto';
import { eq, ne, asc } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { llmUpstreams, llmGatewayModels } from '../schema/index.js';
import type { LlmUpstreamRow, LlmUpstreamKind, LlmGatewayModelRow } from '../schema/llm-gateway.js';

export interface LlmUpstreamInput {
  name: string;
  provider_kind: LlmUpstreamKind;
  base_url: string;
  api_key_enc: string;
  enabled?: boolean;
  created_by?: string;
}

export interface LlmUpstreamUpdateInput {
  name?: string;
  provider_kind?: LlmUpstreamKind;
  base_url?: string;
  api_key_enc?: string; // only set when the admin supplies a new key
  enabled?: boolean;
}

export interface LlmGatewayModelInput {
  public_id: string;
  display_name: string;
  upstream_id: string;
  upstream_model: string;
  enabled?: boolean;
  is_default?: boolean;
  is_public?: boolean;
  sort_order?: number;
}

export interface LlmGatewayModelUpdateInput {
  display_name?: string;
  upstream_id?: string;
  upstream_model?: string;
  enabled?: boolean;
  is_default?: boolean;
  is_public?: boolean;
  sort_order?: number;
}

/** Upstream provider pool — admin-managed real endpoints + encrypted keys. */
export function createLlmUpstreamService(db: Db) {
  const service = {
    async create(input: LlmUpstreamInput): Promise<LlmUpstreamRow> {
      const now = nowIso();
      const id = randomUUID();
      await db.insert(llmUpstreams).values({
        id,
        name: input.name.trim(),
        provider_kind: input.provider_kind,
        base_url: input.base_url.trim(),
        api_key_enc: input.api_key_enc,
        enabled: input.enabled ?? true,
        created_by: input.created_by ?? null,
        created_at: now,
        updated_at: now,
      });
      const rows = await db.select().from(llmUpstreams).where(eq(llmUpstreams.id, id));
      return rows[0]!;
    },

    async getById(id: string): Promise<LlmUpstreamRow | undefined> {
      const rows = await db.select().from(llmUpstreams).where(eq(llmUpstreams.id, id));
      return rows[0];
    },

    async list(): Promise<LlmUpstreamRow[]> {
      return await db.select().from(llmUpstreams).orderBy(asc(llmUpstreams.created_at));
    },

    async update(id: string, updates: LlmUpstreamUpdateInput): Promise<LlmUpstreamRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.name !== undefined) set.name = updates.name.trim();
      if (updates.provider_kind !== undefined) set.provider_kind = updates.provider_kind;
      if (updates.base_url !== undefined) set.base_url = updates.base_url.trim();
      if (updates.api_key_enc !== undefined) set.api_key_enc = updates.api_key_enc;
      if (updates.enabled !== undefined) set.enabled = updates.enabled;

      await db.update(llmUpstreams).set(set).where(eq(llmUpstreams.id, id));
      return service.getById(id);
    },

    async delete(id: string): Promise<boolean> {
      const deleted = await db.delete(llmUpstreams).where(eq(llmUpstreams.id, id)).returning({ id: llmUpstreams.id });
      return deleted.length > 0;
    },
  };
  return service;
}

export type LlmUpstreamService = ReturnType<typeof createLlmUpstreamService>;

/** Public model catalog — what gateway users can select. */
export function createLlmGatewayModelService(db: Db) {
  const service = {
    async create(input: LlmGatewayModelInput): Promise<LlmGatewayModelRow> {
      const now = nowIso();
      const id = randomUUID();
      await db.insert(llmGatewayModels).values({
        id,
        public_id: input.public_id.trim(),
        display_name: input.display_name.trim(),
        upstream_id: input.upstream_id,
        upstream_model: input.upstream_model.trim(),
        enabled: input.enabled ?? true,
        is_default: input.is_default ?? false,
        is_public: input.is_public ?? true,
        sort_order: input.sort_order ?? 0,
        created_at: now,
        updated_at: now,
      });
      const rows = await db.select().from(llmGatewayModels).where(eq(llmGatewayModels.id, id));
      return rows[0]!;
    },

    async getById(id: string): Promise<LlmGatewayModelRow | undefined> {
      const rows = await db.select().from(llmGatewayModels).where(eq(llmGatewayModels.id, id));
      return rows[0];
    },

    async getByPublicId(publicId: string): Promise<LlmGatewayModelRow | undefined> {
      const rows = await db.select().from(llmGatewayModels).where(eq(llmGatewayModels.public_id, publicId.trim()));
      return rows[0];
    },

    async list(): Promise<LlmGatewayModelRow[]> {
      return await db
        .select()
        .from(llmGatewayModels)
        .orderBy(asc(llmGatewayModels.sort_order), asc(llmGatewayModels.created_at));
    },

    /** Only enabled models (for /v1/models and default-subset resolution). */
    async listEnabled(): Promise<LlmGatewayModelRow[]> {
      return await db
        .select()
        .from(llmGatewayModels)
        .where(eq(llmGatewayModels.enabled, true))
        .orderBy(asc(llmGatewayModels.sort_order), asc(llmGatewayModels.created_at));
    },

    async update(id: string, updates: LlmGatewayModelUpdateInput): Promise<LlmGatewayModelRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.display_name !== undefined) set.display_name = updates.display_name.trim();
      if (updates.upstream_id !== undefined) set.upstream_id = updates.upstream_id;
      if (updates.upstream_model !== undefined) set.upstream_model = updates.upstream_model.trim();
      if (updates.enabled !== undefined) set.enabled = updates.enabled;
      if (updates.is_default !== undefined) set.is_default = updates.is_default;
      if (updates.is_public !== undefined) set.is_public = updates.is_public;
      if (updates.sort_order !== undefined) set.sort_order = updates.sort_order;

      await db.update(llmGatewayModels).set(set).where(eq(llmGatewayModels.id, id));
      return service.getById(id);
    },

    async delete(id: string): Promise<boolean> {
      const deleted = await db
        .delete(llmGatewayModels)
        .where(eq(llmGatewayModels.id, id))
        .returning({ id: llmGatewayModels.id });
      return deleted.length > 0;
    },

    /** Clear is_default on every other row (single-default invariant). */
    async clearDefaultExcept(id: string): Promise<void> {
      await db
        .update(llmGatewayModels)
        .set({ is_default: false, updated_at: nowIso() })
        .where(ne(llmGatewayModels.id, id));
    },
  };
  return service;
}

export type LlmGatewayModelService = ReturnType<typeof createLlmGatewayModelService>;
