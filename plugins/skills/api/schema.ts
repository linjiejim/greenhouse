/**
 * Skill Center: skills and their immutable, content-hashed versions.
 *
 * Tables: skills, skill_versions
 *
 * The security scan verdict sits on the skill (quarantine is skill-wide);
 * `scanned_at IS NULL` means never scanned. `setScanResult` does not touch
 * `updated_at` (the catalog sort key).
 */

import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, oneOf, updatedAt } from '@greenhouse/api/extension-kit';

export const SKILL_STATUSES = ['active', 'archived'] as const;
export const SKILL_SCAN_STATUSES = ['pending', 'clean', 'suspicious', 'blocked'] as const;

export const skills = pgTable(
  'skills',
  {
    id: id(),
    /** kebab-case unique slug, immutable after creation. */
    name: text('name').notNull(),
    display_name: text('display_name').notNull(),
    description: text('description').notNull(),
    tags: json<string[]>('tags', []),
    latest_version: text('latest_version').notNull(),
    status: text('status', { enum: SKILL_STATUSES }).notNull().default('active'),
    owner_user_id: text('owner_user_id').notNull(),
    download_count: integer('download_count').notNull().default(0),
    scan_status: text('scan_status', { enum: SKILL_SCAN_STATUSES }).notNull().default('pending'),
    scan_findings: json<unknown[]>('scan_findings', []),
    scan_version: text('scan_version'),
    scanned_at: at('scanned_at'),
    scan_reviewed_by: text('scan_reviewed_by'),
    scan_reviewed_at: at('scan_reviewed_at'),
    scan_note: text('scan_note'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_skills_name').on(table.name),
    index('idx_skills_status').on(table.status),
    index('idx_skills_updated_at').on(table.updated_at),
    index('idx_skills_scan_status').on(table.scan_status),
    oneOf('chk_skills_status', table.status, SKILL_STATUSES),
    oneOf('chk_skills_scan_status', table.scan_status, SKILL_SCAN_STATUSES),
  ],
);

export const skillVersions = pgTable(
  'skill_versions',
  {
    id: id(),
    skill_id: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    /** Strict semver X.Y.Z. */
    version: text('version').notNull(),
    changelog: text('changelog').notNull(),
    file_count: integer('file_count').notNull(),
    size_bytes: integer('size_bytes').notNull(),
    content_hash: text('content_hash').notNull(),
    storage_key: text('storage_key').notNull(),
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_skill_versions_skill_version').on(table.skill_id, table.version),
    index('idx_skill_versions_skill').on(table.skill_id),
  ],
);

export type SkillRow = typeof skills.$inferSelect;
export type SkillStatus = SkillRow['status'];
export type SkillScanStatus = SkillRow['scan_status'];
export type SkillVersionRow = typeof skillVersions.$inferSelect;
