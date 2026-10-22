/**
 * Custom Agent assets and immutable executable versions (PostgreSQL).
 *
 * `custom_profiles` is the stable asset identity. Every configuration edit
 * appends `custom_profile_versions`; no service can update a version.
 *
 * Visibility (v1.4): an Agent is private to its owner unless `is_shared` is
 * true, and only a super switches that (`setShared`). The review lifecycle
 * columns are retired — nothing here reads or writes them.
 */

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import * as schema from '../schema/index.js';
import type { CustomProfileRiskLevel, CustomProfileRow, CustomProfileVersionRow } from '../schema/custom-profile.js';

export interface CustomProfileGovernanceInput {
  purpose?: string | null;
  audience?: string | null;
  risk_level?: CustomProfileRiskLevel;
  budget_policy?: Record<string, unknown>;
  owner_backup_user_id?: string | null;
  change_log?: string;
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
  forked_from?: string;
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

export interface CustomProfileVersionResult {
  profile: CustomProfileRow;
  version: CustomProfileVersionRow;
}

type VersionManifest = Pick<
  CustomProfileVersionRow,
  | 'name'
  | 'description'
  | 'base_profile_id'
  | 'model_id'
  | 'tools'
  | 'system_prompt'
  | 'max_steps'
  | 'avatar'
  | 'purpose'
  | 'audience'
  | 'risk_level'
  | 'budget_policy'
  | 'owner_backup_user_id'
>;

function manifestHash(manifest: VersionManifest): string {
  // The object is built below in a fixed key order. Arrays/objects are already
  // encoded as their persisted JSON text, so this is deterministic across hosts.
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function manifestFromIdentity(
  row: CustomProfileRow,
  updates: CustomProfileUpdateInput = {},
  previous?: CustomProfileVersionRow,
): VersionManifest {
  return {
    name: updates.name ?? row.name,
    description: updates.description !== undefined ? updates.description : row.description,
    base_profile_id: updates.base_profile_id ?? row.base_profile_id,
    model_id: updates.model_id !== undefined ? updates.model_id : row.model_id,
    tools: updates.tools !== undefined ? JSON.stringify(updates.tools) : (previous?.tools ?? row.tools),
    system_prompt: updates.system_prompt ?? row.system_prompt,
    max_steps: updates.max_steps ?? row.max_steps,
    avatar: updates.avatar !== undefined ? JSON.stringify(updates.avatar) : (previous?.avatar ?? row.avatar),
    purpose: updates.purpose !== undefined ? updates.purpose : (previous?.purpose ?? null),
    audience: updates.audience !== undefined ? updates.audience : (previous?.audience ?? null),
    risk_level: updates.risk_level ?? previous?.risk_level ?? 'medium',
    budget_policy:
      updates.budget_policy !== undefined ? JSON.stringify(updates.budget_policy) : (previous?.budget_policy ?? '{}'),
    owner_backup_user_id:
      updates.owner_backup_user_id !== undefined
        ? updates.owner_backup_user_id
        : (previous?.owner_backup_user_id ?? row.owner_backup_user_id),
  };
}

/** User-created Agent assets and their immutable versions. */
export function createCustomProfileService(db: Db) {
  const service = {
    async create(input: CustomProfileInput): Promise<CustomProfileRow> {
      const now = nowIso();
      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(schema.customProfiles)
          .values({
            slug: input.slug,
            user_id: input.user_id,
            name: input.name,
            description: input.description ?? null,
            base_profile_id: input.base_profile_id ?? 'team',
            model_id: input.model_id ?? null,
            tools: JSON.stringify(input.tools),
            system_prompt: input.system_prompt,
            max_steps: input.max_steps ?? 12,
            // Private until a super makes it available to the team.
            is_shared: false,
            avatar: JSON.stringify(input.avatar ?? {}),
            forked_from: input.forked_from ?? null,
            current_version: 1,
            owner_backup_user_id: input.owner_backup_user_id ?? null,
            created_at: now,
            updated_at: now,
          })
          .returning();

        const manifest = manifestFromIdentity(asset, input);
        await tx.insert(schema.customProfileVersions).values({
          profile_id: asset.id,
          version: 1,
          manifest_hash: manifestHash(manifest),
          change_log: input.change_log?.trim() || 'Initial version',
          ...manifest,
          created_by: input.created_by ?? input.user_id,
          created_at: now,
        });
        return asset;
      });
    },

    async getById(id: number): Promise<CustomProfileRow | undefined> {
      const [row] = await db.select().from(schema.customProfiles).where(eq(schema.customProfiles.id, id)).limit(1);
      return row;
    },

    async getVersion(profileId: number, version: number): Promise<CustomProfileVersionRow | undefined> {
      const [row] = await db
        .select()
        .from(schema.customProfileVersions)
        .where(
          and(
            eq(schema.customProfileVersions.profile_id, profileId),
            eq(schema.customProfileVersions.version, version),
          ),
        )
        .limit(1);
      return row;
    },

    async getCurrentVersion(profileId: number): Promise<CustomProfileVersionRow | undefined> {
      const asset = await service.getById(profileId);
      return asset ? service.getVersion(profileId, asset.current_version) : undefined;
    },

    async listVersions(profileId: number): Promise<CustomProfileVersionRow[]> {
      return db
        .select()
        .from(schema.customProfileVersions)
        .where(eq(schema.customProfileVersions.profile_id, profileId))
        .orderBy(desc(schema.customProfileVersions.version));
    },

    /** Assets visible to a user: their own plus every Agent shared with the team. */
    async listForUser(userId: string): Promise<CustomProfileRow[]> {
      return db
        .select()
        .from(schema.customProfiles)
        .where(or(eq(schema.customProfiles.user_id, userId), eq(schema.customProfiles.is_shared, true)))
        .orderBy(asc(schema.customProfiles.name));
    },

    /** Every Agent of every user — the super's view, where team availability is switched. */
    async listAll(): Promise<CustomProfileRow[]> {
      return db.select().from(schema.customProfiles).orderBy(asc(schema.customProfiles.name));
    },

    async createVersion(
      id: number,
      updates: CustomProfileUpdateInput,
    ): Promise<CustomProfileVersionResult | undefined> {
      const now = nowIso();
      return db.transaction(async (tx) => {
        const [asset] = await tx
          .select()
          .from(schema.customProfiles)
          .where(eq(schema.customProfiles.id, id))
          .for('update')
          .limit(1);
        if (!asset) return undefined;

        const [previous] = await tx
          .select()
          .from(schema.customProfileVersions)
          .where(
            and(
              eq(schema.customProfileVersions.profile_id, id),
              eq(schema.customProfileVersions.version, asset.current_version),
            ),
          )
          .limit(1);
        if (!previous) throw new Error(`Current Agent version is missing: custom:${id}@${asset.current_version}`);

        const manifest = manifestFromIdentity(asset, updates, previous);
        const nextVersion = asset.current_version + 1;
        const [version] = await tx
          .insert(schema.customProfileVersions)
          .values({
            profile_id: id,
            version: nextVersion,
            manifest_hash: manifestHash(manifest),
            change_log: updates.change_log?.trim() || `Version ${nextVersion}`,
            ...manifest,
            created_by: updates.created_by ?? asset.user_id,
            created_at: now,
          })
          .returning();

        const [profile] = await tx
          .update(schema.customProfiles)
          .set({
            name: manifest.name,
            description: manifest.description,
            base_profile_id: manifest.base_profile_id,
            model_id: manifest.model_id,
            tools: manifest.tools,
            system_prompt: manifest.system_prompt,
            max_steps: manifest.max_steps,
            avatar: manifest.avatar,
            owner_backup_user_id: manifest.owner_backup_user_id,
            current_version: nextVersion,
            // `is_shared` is deliberately untouched: editing a team Agent keeps
            // it shared, and everyone who picks it next gets this version.
            // Already-pinned work keeps resolving its own immutable version.
            updated_at: now,
          })
          .where(eq(schema.customProfiles.id, id))
          .returning();

        return { profile, version };
      });
    },

    /** Compatibility entry point: edits append an immutable version. */
    async update(id: number, updates: CustomProfileUpdateInput): Promise<CustomProfileRow | undefined> {
      return (await service.createVersion(id, updates))?.profile;
    },

    /** Switch team availability. Only a super may call this (enforced by the route). */
    async setShared(id: number, shared: boolean): Promise<CustomProfileRow | undefined> {
      const [updated] = await db
        .update(schema.customProfiles)
        .set({ is_shared: shared, updated_at: nowIso() })
        .where(eq(schema.customProfiles.id, id))
        .returning();
      return updated;
    },

    /**
     * Delete an Agent and its versions. Sessions and Automations pinned to it
     * stop resolving (they fail closed with "custom Agent no longer exists").
     */
    async delete(id: number): Promise<boolean> {
      const deleted = await db
        .delete(schema.customProfiles)
        .where(eq(schema.customProfiles.id, id))
        .returning({ id: schema.customProfiles.id });
      return deleted.length > 0;
    },

    async countByUser(userId: string): Promise<number> {
      const result = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.customProfiles)
        .where(eq(schema.customProfiles.user_id, userId));
      return result[0]?.count ?? 0;
    },
  };
  return service;
}

export type CustomProfileService = ReturnType<typeof createCustomProfileService>;
