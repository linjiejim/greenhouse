import { sql } from 'drizzle-orm';
import { bigint, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, updatedAt } from './_columns.js';
import { members } from './identity.js';

/** A SKILL.md package (instructions, files, scripts) or a template (instructions and variables). */
export const SKILL_KINDS = ['package', 'template'] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];
/** Team skills are for every member; personal ones for their owner only. */
export const SKILL_SPACES = ['team', 'personal'] as const;
export type SkillSpace = (typeof SKILL_SPACES)[number];
export const SKILL_SCAN_STATUSES = ['pending', 'clean', 'suspicious', 'blocked'] as const;
export type SkillScanStatus = (typeof SKILL_SCAN_STATUSES)[number];

/** What a skill needs to run: the Agent's computer, connectors by slug. */
export type SkillRequirements = { computer?: boolean; connectors?: string[] };
/** A template's fill-in field, like an ask_user field: `{{key}}` in the body. */
export type SkillVariable = {
  key: string;
  label: string;
  type: 'text' | 'choice';
  options?: string[];
  required: boolean;
};
export type SkillScanFinding = { rule: string; severity: 'high' | 'medium'; path?: string; excerpt: string };
/** One file of a package version, by its path in the package. */
export type SkillFileEntry = { path: string; size: number };

/**
 * The skill library. The verdict of the security scan is the skill's (its latest version's):
 * only `clean` skills run. Names are the `/` call names: unique in the team space, and per owner
 * in the personal space; an archived skill keeps its name.
 */
export const skills = pgTable(
  'skills',
  {
    id: id(),
    name: text('name').notNull(),
    displayName: text('display_name').notNull().default(''),
    description: text('description').notNull().default(''),
    kind: text('kind', { enum: SKILL_KINDS }).notNull(),
    space: text('space', { enum: SKILL_SPACES }).notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    tags: json<string[]>('tags', []),
    latestVersion: text('latest_version').notNull(),
    /** The latest version's requirements. */
    requirements: json<SkillRequirements>('requirements', {}),
    scanStatus: text('scan_status', { enum: SKILL_SCAN_STATUSES }).notNull().default('pending'),
    scanFindings: json<SkillScanFinding[]>('scan_findings', []),
    scannedAt: at('scanned_at'),
    /** Who marked it safe or confirmed it malicious; cleared by a new verdict. */
    scanReviewedBy: text('scan_reviewed_by'),
    scanNote: text('scan_note'),
    downloadCount: integer('download_count').notNull().default(0),
    archivedAt: at('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('skills_team_name_key')
      .on(t.name)
      .where(sql`${t.space} = 'team'`),
    uniqueIndex('skills_personal_name_key')
      .on(t.ownerId, t.name)
      .where(sql`${t.space} = 'personal'`),
    index('skills_owner_idx').on(t.ownerId),
  ],
);

/**
 * Immutable versions. `body` is the instruction text: a template's body, or a package's SKILL.md
 * without its frontmatter. A package's bytes are a canonical ZIP in the file service
 * (`bundle_file_id`); `files` lists what is in it. `sha256` hashes the content (the files, or a
 * template's body, variables and requirements), never the ZIP's bytes.
 */
export const skillVersions = pgTable(
  'skill_versions',
  {
    id: id(),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    changelog: text('changelog').notNull().default(''),
    variables: json<SkillVariable[]>('variables', []),
    body: text('body').notNull().default(''),
    bundleFileId: text('bundle_file_id'),
    files: json<SkillFileEntry[]>('files', []),
    fileCount: integer('file_count').notNull().default(0),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    sha256: text('sha256').notNull(),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('skill_versions_version_key').on(t.skillId, t.version),
    index('skill_versions_bundle_idx').on(t.bundleFileId),
  ],
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
export type SkillVersion = typeof skillVersions.$inferSelect;
