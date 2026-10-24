/**
 * Custom Agents (`custom:<id>`) — the `run_profiles` table (PostgreSQL).
 *
 * One row per Agent holds its whole current configuration; `version` counts
 * configuration edits and is bumped by every `update` / `createVersion`.
 * Immutable version rows were retired in 3.0: a 1.x pin `custom:<id>@<n>`
 * (n ≤ version) resolves to the CURRENT configuration. `getVersion`,
 * `getCurrentVersion` and `listVersions` therefore synthesize a version object
 * from the row so those pins keep working (see docs agent-profiles.md).
 *
 * Visibility: an Agent is private to its owner unless `is_shared` is true, and
 * only a super switches that (`setShared`).
 */

import { createHash } from 'node:crypto';
import { asc, eq, or, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { runProfiles } from '../schema/index.js';
import type { CustomProfileRiskLevel, CustomProfileRow } from '../schema/index.js';

export interface CustomProfileGovernanceInput {
  purpose?: string | null;
  audience?: string | null;
  risk_level?: CustomProfileRiskLevel;
  budget_policy?: Record<string, unknown>;
  owner_backup_user_id?: string | null;
  /** Accepted for compatibility; change logs are no longer stored. */
  change_log?: string;
  /** Accepted for compatibility; the editor is not recorded per version. */
  created_by?: string | null;
}

export interface CustomProfileInput extends CustomProfileGovernanceInput {
  slug: string;
  user_id: string;
  name: string;
  description?: string;
  base_profile_id?: string;
  /** Registry model id this agent runs on (omit to inherit the base preset). */
  model_id?: string | null;
  tools: string[];
  system_prompt: string;
  max_steps?: number;
  /** Ignored: a new Agent is always private; a super shares it with `setShared`. */
  is_shared?: boolean;
  avatar?: Record<string, unknown>;
}

export interface CustomProfileUpdateInput extends CustomProfileGovernanceInput {
  name?: string;
  description?: string | null;
  base_profile_id?: string;
  model_id?: string | null;
  tools?: string[];
  system_prompt?: string;
  max_steps?: number;
  avatar?: Record<string, unknown>;
}

/**
 * A configuration snapshot of a custom Agent. Synthesized from the current
 * `run_profiles` row: every version number up to the current one resolves to
 * the current configuration.
 */
export interface CustomProfileVersionRow {
  /** `<profile id>@<version>`. */
  id: string;
  profile_id: string;
  version: number;
  manifest_hash: string;
  change_log: string;
  name: string;
  description: string | null;
  base_profile_id: string;
  model_id: string | null;
  tools: string[];
  system_prompt: string;
  max_steps: number;
  avatar: Record<string, unknown>;
  purpose: string | null;
  audience: string | null;
  risk_level: CustomProfileRiskLevel;
  budget_policy: Record<string, unknown>;
  owner_backup_user_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface CustomProfileVersionResult {
  profile: CustomProfileRow;
  version: CustomProfileVersionRow;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

/** The executable configuration of a row, as a version object. */
function versionOf(row: CustomProfileRow, version = row.version): CustomProfileVersionRow {
  const manifest = {
    name: row.name,
    description: row.description,
    base_profile_id: row.base_profile_id,
    model_id: row.model_id,
    tools: row.tools ?? [],
    system_prompt: row.system_prompt,
    max_steps: row.max_steps,
    avatar: row.avatar ?? {},
    purpose: row.purpose,
    audience: row.audience,
    risk_level: row.risk_level,
    budget_policy: row.budget_policy ?? {},
    owner_backup_user_id: row.owner_backup_user_id,
  };
  return {
    id: `${row.id}@${version}`,
    profile_id: row.id,
    version,
    manifest_hash: createHash('sha256').update(canonical(manifest)).digest('hex'),
    change_log: '',
    ...manifest,
    created_by: row.user_id,
    created_at: row.updated_at,
  };
}

/** User-created Agents. */
export function createCustomProfileService(db: Db) {
  const service = {
    async create(input: CustomProfileInput): Promise<CustomProfileRow> {
      const now = nowIso();
      const [row] = await db
        .insert(runProfiles)
        .values({
          id: newId('runProfile'),
          slug: input.slug,
          user_id: input.user_id,
          name: input.name,
          description: input.description ?? null,
          base_profile_id: input.base_profile_id ?? 'team',
          model_id: input.model_id ?? null,
          tools: input.tools,
          system_prompt: input.system_prompt,
          max_steps: input.max_steps ?? 12,
          // Private until a super makes it available to the team.
          is_shared: false,
          avatar: input.avatar ?? {},
          purpose: input.purpose ?? null,
          audience: input.audience ?? null,
          risk_level: input.risk_level ?? 'medium',
          budget_policy: input.budget_policy ?? {},
          owner_backup_user_id: input.owner_backup_user_id ?? null,
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async getById(id: string): Promise<CustomProfileRow | undefined> {
      const [row] = await db.select().from(runProfiles).where(eq(runProfiles.id, id)).limit(1);
      return row;
    },

    /**
     * Resolve a pinned version. Any `1 ≤ version ≤ current` resolves to the
     * current configuration (immutable versions were retired in 3.0).
     */
    async getVersion(profileId: string, version: number): Promise<CustomProfileVersionRow | undefined> {
      if (!Number.isSafeInteger(version) || version < 1) return undefined;
      const row = await service.getById(profileId);
      if (!row || version > row.version) return undefined;
      return versionOf(row, version);
    },

    async getCurrentVersion(profileId: string): Promise<CustomProfileVersionRow | undefined> {
      const row = await service.getById(profileId);
      return row ? versionOf(row) : undefined;
    },

    /** Only the current configuration exists; older numbers are aliases of it. */
    async listVersions(profileId: string): Promise<CustomProfileVersionRow[]> {
      const current = await service.getCurrentVersion(profileId);
      return current ? [current] : [];
    },

    /** Agents visible to a user: their own plus every Agent shared with the team. */
    async listForUser(userId: string): Promise<CustomProfileRow[]> {
      return db
        .select()
        .from(runProfiles)
        .where(or(eq(runProfiles.user_id, userId), eq(runProfiles.is_shared, true)))
        .orderBy(asc(runProfiles.name));
    },

    /** Every Agent of every user — the super's view, where team availability is switched. */
    async listAll(): Promise<CustomProfileRow[]> {
      return db.select().from(runProfiles).orderBy(asc(runProfiles.name));
    },

    /** Apply a configuration edit and bump `version`. */
    async createVersion(
      id: string,
      updates: CustomProfileUpdateInput,
    ): Promise<CustomProfileVersionResult | undefined> {
      const set: Partial<typeof runProfiles.$inferInsert> = {};
      if (updates.name !== undefined) set.name = updates.name;
      if (updates.description !== undefined) set.description = updates.description;
      if (updates.base_profile_id !== undefined) set.base_profile_id = updates.base_profile_id;
      if (updates.model_id !== undefined) set.model_id = updates.model_id;
      if (updates.tools !== undefined) set.tools = updates.tools;
      if (updates.system_prompt !== undefined) set.system_prompt = updates.system_prompt;
      if (updates.max_steps !== undefined) set.max_steps = updates.max_steps;
      if (updates.avatar !== undefined) set.avatar = updates.avatar;
      if (updates.purpose !== undefined) set.purpose = updates.purpose;
      if (updates.audience !== undefined) set.audience = updates.audience;
      if (updates.risk_level !== undefined) set.risk_level = updates.risk_level;
      if (updates.budget_policy !== undefined) set.budget_policy = updates.budget_policy;
      if (updates.owner_backup_user_id !== undefined) set.owner_backup_user_id = updates.owner_backup_user_id;
      // `is_shared` is deliberately untouched: editing a team Agent keeps it shared.
      const [profile] = await db
        .update(runProfiles)
        .set({ ...set, version: sql`${runProfiles.version} + 1`, updated_at: nowIso() })
        .where(eq(runProfiles.id, id))
        .returning();
      if (!profile) return undefined;
      return { profile, version: versionOf(profile) };
    },

    /** Compatibility entry point: an edit bumps the version. */
    async update(id: string, updates: CustomProfileUpdateInput): Promise<CustomProfileRow | undefined> {
      return (await service.createVersion(id, updates))?.profile;
    },

    /** Switch team availability. Only a super may call this (enforced by the route). */
    async setShared(id: string, shared: boolean): Promise<CustomProfileRow | undefined> {
      const [updated] = await db
        .update(runProfiles)
        .set({ is_shared: shared, updated_at: nowIso() })
        .where(eq(runProfiles.id, id))
        .returning();
      return updated;
    },

    /**
     * Delete an Agent. Sessions and Automations pinned to it stop resolving
     * (they fail closed with "custom Agent no longer exists").
     */
    async delete(id: string): Promise<boolean> {
      const deleted = await db.delete(runProfiles).where(eq(runProfiles.id, id)).returning({ id: runProfiles.id });
      return deleted.length > 0;
    },

    async countByUser(userId: string): Promise<number> {
      const result = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(runProfiles)
        .where(eq(runProfiles.user_id, userId));
      return result[0]?.count ?? 0;
    },
  };
  return service;
}

export type CustomProfileService = ReturnType<typeof createCustomProfileService>;
