/**
 * Skill Center service — skill catalog + immutable version history (PostgreSQL).
 *
 * Pure persistence: bundle payloads, semver rules and permission checks live in
 * the API layer (apps/api/src/skills/). Version rows are append-only — there is
 * deliberately no updateVersion/deleteVersion; history must stay trustworthy.
 */

import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { agentSkills, agentSkillVersions } from '../schema/index.js';
import type { SkillRow, SkillScanStatus, SkillStatus, SkillVersionRow } from '../schema/skill.js';

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
  scan_status?: SkillScanStatus;
  limit?: number;
  offset?: number;
}

/** Scanner verdict (written by the publish path / rescan / boot sweep). */
export interface SkillScanResultInput {
  status: SkillScanStatus;
  /** JSON-serializable finding list; stored as text per the JSON-as-text rule. */
  findings: unknown[];
  /** The version the verdict was produced from. */
  version: string;
  /**
   * Apply only while this is still the skill's latest version.
   *
   * Two concurrent publishes of the same skill produce two verdicts; without
   * this guard the slower one wins the write regardless of which bundle it
   * describes, so an older `clean` result can land after a newer bundle was
   * quarantined and silently un-quarantine the skill. Omit it for rescans of
   * whatever is currently latest.
   */
  onlyIfLatestVersion?: string;
}

/** Human ruling by a super admin (clean / blocked). */
export interface SkillScanDecisionInput {
  status: SkillScanStatus;
  reviewed_by: string;
  note?: string;
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
      if (opts?.scan_status) conds.push(eq(agentSkills.scan_status, opts.scan_status));
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

    async count(opts?: Pick<SkillListOpts, 'q' | 'status' | 'scan_status'>): Promise<number> {
      const conds = [];
      if (opts?.status) conds.push(eq(agentSkills.status, opts.status));
      if (opts?.scan_status) conds.push(eq(agentSkills.scan_status, opts.scan_status));
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

    /** Metadata participates in the security verdict, so update both atomically. */
    async updateMetaWithScan(
      skillId: number,
      updates: SkillMetaUpdateInput,
      scan: SkillScanResultInput,
    ): Promise<SkillRow | undefined> {
      const set: Record<string, unknown> = {
        updated_at: nowIso(),
        scan_status: scan.status,
        scan_findings: JSON.stringify(scan.findings),
        scan_version: scan.version,
        scanned_at: nowIso(),
        scan_reviewed_by: null,
        scan_reviewed_at: null,
        scan_note: null,
      };
      if (updates.display_name !== undefined) set.display_name = updates.display_name;
      if (updates.description !== undefined) set.description = updates.description;
      if (updates.tags !== undefined) set.tags = JSON.stringify(updates.tags);
      const rows = await db
        .update(agentSkills)
        .set(set)
        .where(and(eq(agentSkills.id, skillId), eq(agentSkills.latest_version, scan.version)))
        .returning();
      return rows[0];
    },

    async setStatus(skillId: number, status: SkillStatus): Promise<SkillRow | undefined> {
      await db.update(agentSkills).set({ status, updated_at: nowIso() }).where(eq(agentSkills.id, skillId));
      return service.getById(skillId);
    },

    /**
     * Record a scanner verdict. Deliberately does NOT touch `updated_at` — that
     * column orders the catalog, and a background rescan must not reshuffle the
     * list. The human review fields are cleared: a fresh scan supersedes an old
     * ruling (a `blocked` skill never reaches here — publish refuses it).
     *
     * With `onlyIfLatestVersion` the write is a no-op when a newer publish has
     * already moved `latest_version` on — the newer scan's verdict stands.
     */
    async setScanResult(skillId: number, input: SkillScanResultInput): Promise<SkillRow | undefined> {
      const where =
        input.onlyIfLatestVersion === undefined
          ? eq(agentSkills.id, skillId)
          : and(eq(agentSkills.id, skillId), eq(agentSkills.latest_version, input.onlyIfLatestVersion));
      await db
        .update(agentSkills)
        .set({
          scan_status: input.status,
          scan_findings: JSON.stringify(input.findings),
          scan_version: input.version,
          scanned_at: nowIso(),
          scan_reviewed_by: null,
          scan_reviewed_at: null,
          scan_note: null,
        })
        .where(where);
      return service.getById(skillId);
    },

    /** Record a super admin's ruling (clean / blocked), keeping the findings for the record. */
    async setScanDecision(skillId: number, input: SkillScanDecisionInput): Promise<SkillRow | undefined> {
      await db
        .update(agentSkills)
        .set({
          scan_status: input.status,
          scan_reviewed_by: input.reviewed_by,
          scan_reviewed_at: nowIso(),
          scan_note: input.note ?? null,
        })
        .where(eq(agentSkills.id, skillId));
      return service.getById(skillId);
    },

    /** Skills that have never been scanned (rows predating the scanner) — oldest first. */
    async listUnscanned(limit = 100): Promise<SkillRow[]> {
      return await db
        .select()
        .from(agentSkills)
        .where(isNull(agentSkills.scanned_at))
        .orderBy(asc(agentSkills.id))
        .limit(limit);
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
