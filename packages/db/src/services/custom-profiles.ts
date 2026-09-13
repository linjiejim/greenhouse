/**
 * Custom Agent assets and immutable executable versions (PostgreSQL).
 *
 * `custom_profiles` is the stable asset identity. Every configuration edit
 * appends `custom_profile_versions`; no service can update/delete a version.
 */

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import * as schema from '../schema/index.js';
import type {
  CustomProfileLifecycleStatus,
  CustomProfileRiskLevel,
  CustomProfileRow,
  CustomProfileVersionRow,
} from '../schema/custom-profile.js';
import type { UserStatus } from '../schema/user.js';

export interface CustomProfileGovernanceInput {
  purpose?: string | null;
  audience?: string | null;
  risk_level?: CustomProfileRiskLevel;
  budget_policy?: Record<string, unknown>;
  eval_refs?: unknown[];
  owner_backup_user_id?: string | null;
  review_due_at?: string | null;
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
  /** Legacy input is ignored: sharing is derived from reviewed lifecycle state. */
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

export interface CustomProfileLifecycleInput {
  status: CustomProfileLifecycleStatus;
  actor_user_id: string;
  note?: string | null;
  publish_version?: number | null;
  next_review_at?: string | null;
}

export interface CustomProfileVersionResult {
  profile: CustomProfileRow;
  version: CustomProfileVersionRow;
}

export interface CustomProfileOwnershipCandidate {
  profile: CustomProfileRow;
  owner_status: UserStatus;
  backup_owner_status: UserStatus | null;
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
  | 'eval_refs'
  | 'owner_backup_user_id'
  | 'review_due_at'
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
    eval_refs: updates.eval_refs !== undefined ? JSON.stringify(updates.eval_refs) : (previous?.eval_refs ?? '[]'),
    owner_backup_user_id:
      updates.owner_backup_user_id !== undefined
        ? updates.owner_backup_user_id
        : (previous?.owner_backup_user_id ?? row.owner_backup_user_id),
    review_due_at: updates.review_due_at !== undefined ? updates.review_due_at : (previous?.review_due_at ?? null),
  };
}

const ALLOWED_LIFECYCLE_TRANSITIONS: Record<CustomProfileLifecycleStatus, ReadonlySet<CustomProfileLifecycleStatus>> = {
  draft: new Set(['review', 'archived']),
  review: new Set(['draft', 'pilot', 'verified', 'rejected', 'archived']),
  pilot: new Set(['verified', 'rejected', 'suspended', 'deprecated', 'archived']),
  verified: new Set(['suspended', 'deprecated', 'archived']),
  rejected: new Set(['draft', 'review', 'archived']),
  suspended: new Set(['pilot', 'verified', 'deprecated', 'archived']),
  deprecated: new Set(['archived']),
  archived: new Set(),
};

function requiresPublishedVersion(status: CustomProfileLifecycleStatus): boolean {
  return status === 'pilot' || status === 'verified';
}

function defaultReviewAt(now: string, riskLevel: CustomProfileRiskLevel): string {
  const reviewDays = riskLevel === 'high' ? 60 : 90;
  return new Date(Date.parse(now) + reviewDays * 24 * 60 * 60 * 1000).toISOString();
}

/** User-created Agent assets and their immutable versions. */
export function createCustomProfileService(db: Db) {
  const backupOwner = alias(schema.users, 'custom_profile_backup_owner');

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
            // A reviewed lifecycle transition is the only path that may share.
            is_shared: false,
            avatar: JSON.stringify(input.avatar ?? {}),
            forked_from: input.forked_from ?? null,
            current_version: 1,
            published_version: null,
            lifecycle_status: 'draft',
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

    async getPublishedVersion(profileId: number): Promise<CustomProfileVersionRow | undefined> {
      const asset = await service.getById(profileId);
      return asset?.published_version ? service.getVersion(profileId, asset.published_version) : undefined;
    },

    async listVersions(profileId: number): Promise<CustomProfileVersionRow[]> {
      return db
        .select()
        .from(schema.customProfileVersions)
        .where(eq(schema.customProfileVersions.profile_id, profileId))
        .orderBy(desc(schema.customProfileVersions.version));
    },

    /** List assets visible to a user: own + reviewed/published assets from others. */
    async listForUser(userId: string): Promise<CustomProfileRow[]> {
      return db
        .select()
        .from(schema.customProfiles)
        .where(
          and(
            sql`${schema.customProfiles.lifecycle_status} <> 'archived'`,
            or(
              eq(schema.customProfiles.user_id, userId),
              and(
                eq(schema.customProfiles.is_shared, true),
                inArray(schema.customProfiles.lifecycle_status, ['pilot', 'verified']),
                isNotNull(schema.customProfiles.published_version),
              ),
            ),
          ),
        )
        .orderBy(asc(schema.customProfiles.name));
    },

    /** Super governance queue: all non-archived assets, including unshared review drafts. */
    async listAll(): Promise<CustomProfileRow[]> {
      return db
        .select()
        .from(schema.customProfiles)
        .where(sql`${schema.customProfiles.lifecycle_status} <> 'archived'`)
        .orderBy(asc(schema.customProfiles.name));
    },

    /** Stable input for the review-due sweeper; the worker owns transition policy. */
    async listReviewDue(at: string, limit = 100): Promise<CustomProfileRow[]> {
      return db
        .select()
        .from(schema.customProfiles)
        .where(
          and(
            inArray(schema.customProfiles.lifecycle_status, ['pilot', 'verified']),
            lte(schema.customProfiles.next_review_at, at),
          ),
        )
        .orderBy(asc(schema.customProfiles.next_review_at), asc(schema.customProfiles.id))
        .limit(Math.max(1, Math.min(limit, 500)));
    },

    /**
     * Stable cursor query for owner-continuity checks. The logical governance
     * actor may subsequently transition candidates as `system:agent-governance`.
     */
    async listActiveWithOwners(limit = 100, afterId = 0): Promise<CustomProfileOwnershipCandidate[]> {
      return db
        .select({
          profile: schema.customProfiles,
          owner_status: schema.users.status,
          backup_owner_status: backupOwner.status,
        })
        .from(schema.customProfiles)
        .innerJoin(schema.users, eq(schema.customProfiles.user_id, schema.users.id))
        .leftJoin(backupOwner, eq(schema.customProfiles.owner_backup_user_id, backupOwner.id))
        .where(and(sql`${schema.customProfiles.lifecycle_status} <> 'archived'`, gt(schema.customProfiles.id, afterId)))
        .orderBy(asc(schema.customProfiles.id))
        .limit(Math.max(1, Math.min(limit, 500)));
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
        if (asset.lifecycle_status === 'archived') {
          throw new Error('Archived Agent cannot receive new versions');
        }

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
            // Any executable or governance edit invalidates the prior review.
            // This model deliberately has no independent release channel: the
            // old immutable reference still resolves for already-pinned work,
            // but it is no longer discoverable or selectable by other users.
            lifecycle_status: 'draft',
            lifecycle_note: null,
            published_version: null,
            is_shared: false,
            reviewed_by: null,
            reviewed_at: null,
            next_review_at: null,
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

    async transitionLifecycle(id: number, input: CustomProfileLifecycleInput): Promise<CustomProfileRow | undefined> {
      const now = nowIso();
      return db.transaction(async (tx) => {
        const [asset] = await tx
          .select()
          .from(schema.customProfiles)
          .where(eq(schema.customProfiles.id, id))
          .for('update')
          .limit(1);
        if (!asset) return undefined;
        if (asset.lifecycle_status === input.status) {
          throw new Error(`Agent lifecycle is already ${input.status}; no state change was applied`);
        }
        if (!ALLOWED_LIFECYCLE_TRANSITIONS[asset.lifecycle_status].has(input.status)) {
          throw new Error(`Invalid Agent lifecycle transition: ${asset.lifecycle_status} -> ${input.status}`);
        }

        let publishVersion = asset.published_version;
        let publishedReviewDueAt: string | null = null;
        if (requiresPublishedVersion(input.status)) {
          publishVersion = input.publish_version ?? asset.current_version;
          const [candidate] = await tx
            .select({
              version: schema.customProfileVersions.version,
              review_due_at: schema.customProfileVersions.review_due_at,
              risk_level: schema.customProfileVersions.risk_level,
            })
            .from(schema.customProfileVersions)
            .where(
              and(
                eq(schema.customProfileVersions.profile_id, id),
                eq(schema.customProfileVersions.version, publishVersion),
              ),
            )
            .limit(1);
          if (!candidate) throw new Error(`Agent version does not exist: custom:${id}@${publishVersion}`);
          publishedReviewDueAt = candidate.review_due_at ?? defaultReviewAt(now, candidate.risk_level);
        }

        const shared = requiresPublishedVersion(input.status);
        const [updated] = await tx
          .update(schema.customProfiles)
          .set({
            lifecycle_status: input.status,
            lifecycle_note: input.note ?? null,
            published_version: publishVersion,
            is_shared: shared,
            reviewed_by: input.status === 'review' || input.status === 'draft' ? null : input.actor_user_id,
            reviewed_at: input.status === 'review' || input.status === 'draft' ? null : now,
            next_review_at: shared ? (input.next_review_at ?? publishedReviewDueAt) : null,
            updated_at: now,
          })
          .where(eq(schema.customProfiles.id, id))
          .returning();
        return updated;
      });
    },

    /** Retain history: API deletion is lifecycle archival, never physical delete. */
    async archive(id: number, actorUserId: string, note?: string): Promise<CustomProfileRow | undefined> {
      return service.transitionLifecycle(id, {
        status: 'archived',
        actor_user_id: actorUserId,
        note: note ?? 'Archived by owner',
      });
    },

    async countByUser(userId: string): Promise<number> {
      const result = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.customProfiles)
        .where(
          and(eq(schema.customProfiles.user_id, userId), sql`${schema.customProfiles.lifecycle_status} <> 'archived'`),
        );
      return result[0]?.count ?? 0;
    },
  };
  return service;
}

export type CustomProfileService = ReturnType<typeof createCustomProfileService>;
