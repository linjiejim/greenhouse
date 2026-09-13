/**
 * Drizzle schema — Skill Center (PostgreSQL).
 *
 * Tables: agent_skills, agent_skill_versions
 *
 * The enterprise skill hub: members publish agent skills (a named folder of
 * files with SKILL.md at the root) and pull each other's over chat / the agent
 * proxy / MCP. Version payloads (the file bundles) live in the skill store
 * (local disk by default, S3-compatible optional — apps/api/src/skills/store.ts);
 * the DB keeps the catalog + immutable version history with changelogs.
 * Ported from OSS greenhouse — see docs/specs/20260715-greenhouse-backport-and-slim.md (B7).
 */

import { integer, pgTable, text, serial, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// ─── agent_skills ────────────────────────────────────────

export const agentSkills = pgTable(
  'agent_skills',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(), // kebab-case unique slug, immutable after creation
    display_name: text('display_name').notNull(),
    description: text('description').notNull(),
    tags: text('tags').notNull().default('[]'), // JSON array
    latest_version: text('latest_version').notNull(), // denormalized from agent_skill_versions for list views
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    // Loose ref to users (no FK) — skills must outlive the member who published them.
    owner_user_id: text('owner_user_id').notNull(),
    download_count: integer('download_count').notNull().default(0),
    // ── Security scan (skill-level, not version-level) ──
    // Quarantine is a property of the whole skill: an author who poisoned v2 is
    // not to be trusted for v1 either. `scan_version` records WHICH version the
    // verdict came from. `blocked` is sticky — only a super can lift it.
    scan_status: text('scan_status', { enum: ['pending', 'clean', 'suspicious', 'blocked'] })
      .notNull()
      .default('pending'),
    scan_findings: text('scan_findings').notNull().default('[]'), // JSON array of matched rules
    scan_version: text('scan_version'), // semantic NULL = never scanned
    scanned_at: timestamp('scanned_at', { withTimezone: true, mode: 'string' }),
    scan_reviewed_by: text('scan_reviewed_by'), // loose ref to users (super who ruled)
    scan_reviewed_at: timestamp('scan_reviewed_at', { withTimezone: true, mode: 'string' }),
    scan_note: text('scan_note'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_agent_skills_name').on(table.name),
    index('idx_agent_skills_status').on(table.status),
    index('idx_agent_skills_updated_at').on(table.updated_at),
    index('idx_agent_skills_scan_status').on(table.scan_status),
  ],
);

// ─── agent_skill_versions ────────────────────────────────
// Immutable history — one row per published version, changelog mandatory.

export const agentSkillVersions = pgTable(
  'agent_skill_versions',
  {
    id: serial('id').primaryKey(),
    skill_id: integer('skill_id')
      .notNull()
      .references(() => agentSkills.id, { onDelete: 'cascade' }),
    version: text('version').notNull(), // strict semver X.Y.Z
    changelog: text('changelog').notNull(),
    file_count: integer('file_count').notNull(),
    size_bytes: integer('size_bytes').notNull(),
    content_hash: text('content_hash').notNull(), // sha256 over the canonical bundle
    storage_key: text('storage_key').notNull(), // object key in the skill store
    created_by: text('created_by').notNull(), // loose ref to users
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_agent_skill_versions_skill_version').on(table.skill_id, table.version),
    index('idx_agent_skill_versions_skill').on(table.skill_id),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type SkillRow = typeof agentSkills.$inferSelect;
export type SkillStatus = SkillRow['status'];
export type SkillScanStatus = SkillRow['scan_status'];
export type SkillVersionRow = typeof agentSkillVersions.$inferSelect;
