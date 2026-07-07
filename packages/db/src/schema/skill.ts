/**
 * Drizzle schema — Skill Center (PostgreSQL).
 *
 * Tables: agent_skills, agent_skill_versions
 *
 * The enterprise skill hub: members publish agent skills (a named folder of
 * files with SKILL.md at the root) and pull each other's over chat / the agent
 * proxy / MCP. Version payloads (the file bundles) live in the skill store
 * (S3-compatible or local disk — apps/api/src/skills/store.ts); the DB keeps
 * the catalog + immutable version history with changelogs.
 * See docs/specs/20260707-skill-center.md.
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
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_agent_skills_name').on(table.name),
    index('idx_agent_skills_status').on(table.status),
    index('idx_agent_skills_updated_at').on(table.updated_at),
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
export type SkillVersionRow = typeof agentSkillVersions.$inferSelect;
