/**
 * Skill Center service — skill catalog + immutable version history (PostgreSQL).
 *
 * Pure persistence: bundle payloads, semver rules and permission checks live in
 * the API layer (apps/api/src/skills/). Version rows are append-only — there is
 * deliberately no updateVersion/deleteVersion; history must stay trustworthy.
 */

import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { agentSkills, agentSkillVersions } from '../schema/index.js';
import type { SkillRow, SkillStatus, SkillVersionRow } from '../schema/skill.js';

export interface SkillCreateInput {
  name: string;
  display_name?: string;
  description: string;
  tags?: string[];
  owner_user_id: string;
}

export interface SkillVersionInput {
  version: string;
  changelog: string;
  file_count: number;
  size_bytes: number;
  content_hash: string;
  storage_key: string;
  created_by: string;
}

export interface SkillMetaUpdateInput {
  display_name?: string;
  description?: string;
  tags?: string[];
}

export interface SkillListOpts {
  /** Keyword — ILIKE over name / display_name / description / tags. */
  q?: string;
  status?: SkillStatus;
  limit?: number;
  offset?: number;
}

export function createSkillService(db: Db) {
  const service = {
    /** Create the catalog row + its first version in one transaction. */
    async create(input: SkillCreateInput, first: SkillVersionInput): Promise<SkillRow> {
      const now = nowIso();
      return await db.transaction(async (tx) => {
        const [skill] = await tx
          .insert(agentSkills)
          .values({
            name: input.name,
            display_name: input.display_name || input.name,
            description: input.description,
            tags: JSON.stringify(input.tags ?? []),
            latest_version: first.version,
            owner_user_id: input.owner_user_id,
            created_at: now,
            updated_at: now,
          })
          .returning();
        await tx.insert(agentSkillVersions).values({ skill_id: skill!.id, ...first, created_at: now });
        return skill!;
      });
    },

    /** Append a version and bump the denormalized latest_version, in one transaction. */
    async addVersion(skillId: number, input: SkillVersionInput): Promise<SkillVersionRow> {
      const now = nowIso();
      return await db.transaction(async (tx) => {
        const [version] = await tx
          .insert(agentSkillVersions)
          .values({ skill_id: skillId, ...input, created_at: now })
          .returning();
        await tx
          .update(agentSkills)
          .set({ latest_version: input.version, updated_at: now })
          .where(eq(agentSkills.id, skillId));
        return version!;
      });
    },

    async getById(id: number): Promise<SkillRow | undefined> {
      return (await db.select().from(agentSkills).where(eq(agentSkills.id, id)))[0];
    },

    async getByName(name: string): Promise<SkillRow | undefined> {
      return (await db.select().from(agentSkills).where(eq(agentSkills.name, name)))[0];
    },

    async list(opts?: SkillListOpts): Promise<SkillRow[]> {
      const conds = [];
      if (opts?.status) conds.push(eq(agentSkills.status, opts.status));
      if (opts?.q) {
        const pattern = `%${opts.q}%`;
        conds.push(
          or(
            ilike(agentSkills.name, pattern),
            ilike(agentSkills.display_name, pattern),
            ilike(agentSkills.description, pattern),
            ilike(agentSkills.tags, pattern),
          ),
        );
      }
      return await db
        .select()
        .from(agentSkills)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(agentSkills.updated_at))
        .limit(opts?.limit ?? 50)
        .offset(opts?.offset ?? 0);
    },

    async count(opts?: Pick<SkillListOpts, 'q' | 'status'>): Promise<number> {
      const conds = [];
      if (opts?.status) conds.push(eq(agentSkills.status, opts.status));
      if (opts?.q) {
        const pattern = `%${opts.q}%`;
        conds.push(
          or(
            ilike(agentSkills.name, pattern),
            ilike(agentSkills.display_name, pattern),
            ilike(agentSkills.description, pattern),
            ilike(agentSkills.tags, pattern),
          ),
        );
      }
      const row = (
        await db
          .select({ cnt: sql<number>`COUNT(*)` })
          .from(agentSkills)
          .where(conds.length ? and(...conds) : undefined)
      )[0];
      return Number(row?.cnt ?? 0);
    },

    /** Version history, newest first. */
    async listVersions(skillId: number): Promise<SkillVersionRow[]> {
      return await db
        .select()
        .from(agentSkillVersions)
        .where(eq(agentSkillVersions.skill_id, skillId))
        .orderBy(desc(agentSkillVersions.id));
    },

    async getVersion(skillId: number, version: string): Promise<SkillVersionRow | undefined> {
      return (
        await db
          .select()
          .from(agentSkillVersions)
          .where(and(eq(agentSkillVersions.skill_id, skillId), eq(agentSkillVersions.version, version)))
      )[0];
    },

    async updateMeta(skillId: number, updates: SkillMetaUpdateInput): Promise<SkillRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.display_name !== undefined) set.display_name = updates.display_name;
      if (updates.description !== undefined) set.description = updates.description;
      if (updates.tags !== undefined) set.tags = JSON.stringify(updates.tags);
      await db.update(agentSkills).set(set).where(eq(agentSkills.id, skillId));
      return service.getById(skillId);
    },

    async setStatus(skillId: number, status: SkillStatus): Promise<SkillRow | undefined> {
      await db.update(agentSkills).set({ status, updated_at: nowIso() }).where(eq(agentSkills.id, skillId));
      return service.getById(skillId);
    },

    async incrementDownloads(skillId: number): Promise<void> {
      await db
        .update(agentSkills)
        .set({ download_count: sql`${agentSkills.download_count} + 1` })
        .where(eq(agentSkills.id, skillId));
    },

    /** Hard delete (versions cascade). Storage objects are the caller's job. */
    async remove(skillId: number): Promise<boolean> {
      const deleted = await db.delete(agentSkills).where(eq(agentSkills.id, skillId)).returning({ id: agentSkills.id });
      return deleted.length > 0;
    },
  };
  return service;
}

export type SkillService = ReturnType<typeof createSkillService>;
