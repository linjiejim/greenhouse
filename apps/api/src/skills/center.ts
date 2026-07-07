/**
 * Skill Center orchestration — ONE implementation of publish / download /
 * sync-check / manage, shared by the HTTP routes (routes/skills.ts) and the
 * agent tools (tools/skills/*). Permission model (see the spec): reads for all
 * internal users; writes for the skill owner or a super; hard delete super-only.
 *
 * Results are discriminated unions with a `code` instead of thrown errors so
 * the routes can map codes to HTTP statuses and the tools can return the
 * message to the model as-is.
 */

import { safeJsonParse } from '@greenhouse/utils/json';
import { bumpPatch, compareSemver, isValidSemver } from '@greenhouse/utils/semver';
import { logger } from '@greenhouse/utils/logger';
import type { DatabaseProvider, SkillRow, SkillVersionRow } from '@greenhouse/db';
import {
  buildBundleJson,
  bundleContentHash,
  parseBundleJson,
  parseSkillMdFrontmatter,
  validateBundleFiles,
  validateSkillName,
  type SkillFile,
} from './bundle.js';
import { getSkillStore, storageKeyFor } from './store.js';

export interface Actor {
  userId: string;
  role: string;
}

export type SkillErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict';
export type SkillError = { ok: false; code: SkillErrorCode; error: string };
const err = (code: SkillErrorCode, error: string): SkillError => ({ ok: false, code, error });

/** The wire shape for a catalog entry (tags decoded from the JSON column). */
export interface SkillSummary {
  name: string;
  display_name: string;
  description: string;
  tags: string[];
  latest_version: string;
  status: SkillRow['status'];
  owner_user_id: string;
  download_count: number;
  created_at: string;
  updated_at: string;
}

export interface SkillVersionSummary {
  version: string;
  changelog: string;
  file_count: number;
  size_bytes: number;
  content_hash: string;
  created_by: string;
  created_at: string;
}

export function toSkillSummary(row: SkillRow): SkillSummary {
  return {
    name: row.name,
    display_name: row.display_name,
    description: row.description,
    tags: safeJsonParse(row.tags, []) as string[],
    latest_version: row.latest_version,
    status: row.status,
    owner_user_id: row.owner_user_id,
    download_count: row.download_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toVersionSummary(row: SkillVersionRow): SkillVersionSummary {
  return {
    version: row.version,
    changelog: row.changelog,
    file_count: row.file_count,
    size_bytes: row.size_bytes,
    content_hash: row.content_hash,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

function canManage(actor: Actor, skill: SkillRow): boolean {
  return actor.role === 'super' || skill.owner_user_id === actor.userId;
}

// ─── Publish ─────────────────────────────────────────────

export interface PublishInput {
  name: string;
  display_name?: string;
  description?: string;
  tags?: string[];
  /** Strict semver; omitted → 0.1.0 for a new skill, patch-bump for an update. */
  version?: string;
  /** Mandatory when updating an existing skill. */
  changelog?: string;
  files: SkillFile[];
}

export type PublishResult =
  | { ok: true; created: boolean; skill: SkillSummary; version: SkillVersionSummary }
  | SkillError;

export async function publishSkill(db: DatabaseProvider, actor: Actor, input: PublishInput): Promise<PublishResult> {
  const nameError = validateSkillName(input.name ?? '');
  if (nameError) return err('invalid', nameError);

  const validated = validateBundleFiles(input.files ?? []);
  if (!validated.ok) return err('invalid', validated.error);
  const { files, fileCount, sizeBytes } = validated.value;

  // SKILL.md is the in-bundle identity — a mismatched frontmatter name means the
  // caller is publishing folder A under name B; refuse instead of guessing.
  const skillMd = files.find((f) => f.path === 'SKILL.md')!;
  const frontmatter = skillMd.encoding === 'base64' ? {} : parseSkillMdFrontmatter(skillMd.content);
  if (frontmatter.name && frontmatter.name !== input.name) {
    return err('invalid', `SKILL.md frontmatter name "${frontmatter.name}" does not match skill name "${input.name}"`);
  }

  const contentHash = bundleContentHash(files);
  const existing = await db.skills.getByName(input.name);

  if (!existing) {
    const description = input.description?.trim() || frontmatter.description || '';
    if (!description) return err('invalid', 'description is required (or provide one in SKILL.md frontmatter)');
    const version = input.version ?? '0.1.0';
    if (!isValidSemver(version)) return err('invalid', `Invalid version "${version}" — use strict X.Y.Z`);
    const changelog = input.changelog?.trim() || 'Initial release';

    const storageKey = storageKeyFor(input.name, version);
    await getSkillStore().put(storageKey, buildBundleJson(input.name, version, files));
    try {
      const skill = await db.skills.create(
        {
          name: input.name,
          display_name: input.display_name?.trim() || undefined,
          description,
          tags: input.tags,
          owner_user_id: actor.userId,
        },
        {
          version,
          changelog,
          file_count: fileCount,
          size_bytes: sizeBytes,
          content_hash: contentHash,
          storage_key: storageKey,
          created_by: actor.userId,
        },
      );
      const versionRow = (await db.skills.getVersion(skill.id, version))!;
      return { ok: true, created: true, skill: toSkillSummary(skill), version: toVersionSummary(versionRow) };
    } catch {
      // Likely a concurrent create of the same name — don't leave an orphan bundle.
      await getSkillStore()
        .delete(storageKey)
        .catch(() => {});
      return err('conflict', `Skill "${input.name}" already exists (or create failed) — retry as an update`);
    }
  }

  // ── Update path (new version of an existing skill) ──
  if (!canManage(actor, existing)) {
    return err('forbidden', `Only the owner of "${existing.name}" (or a super admin) can publish new versions`);
  }
  if (existing.status === 'archived') {
    return err('conflict', `Skill "${existing.name}" is archived — unarchive it before publishing`);
  }
  const changelog = input.changelog?.trim();
  if (!changelog) return err('invalid', 'changelog is required when updating a skill — describe what changed');

  let version: string;
  if (input.version !== undefined) {
    if (!isValidSemver(input.version)) return err('invalid', `Invalid version "${input.version}" — use strict X.Y.Z`);
    if (compareSemver(input.version, existing.latest_version) <= 0) {
      return err('conflict', `Version ${input.version} must be greater than the latest (${existing.latest_version})`);
    }
    version = input.version;
  } else {
    version = bumpPatch(existing.latest_version);
  }

  const latestRow = await db.skills.getVersion(existing.id, existing.latest_version);
  if (latestRow && latestRow.content_hash === contentHash) {
    return err('conflict', `Content is identical to v${existing.latest_version} — nothing to publish`);
  }

  const storageKey = storageKeyFor(existing.name, version);
  await getSkillStore().put(storageKey, buildBundleJson(existing.name, version, files));
  let versionRow: SkillVersionRow;
  try {
    versionRow = await db.skills.addVersion(existing.id, {
      version,
      changelog,
      file_count: fileCount,
      size_bytes: sizeBytes,
      content_hash: contentHash,
      storage_key: storageKey,
      created_by: actor.userId,
    });
  } catch {
    await getSkillStore()
      .delete(storageKey)
      .catch(() => {});
    return err('conflict', `Version ${version} of "${existing.name}" already exists — pick a higher version`);
  }

  // Publish may also carry catalog-meta refreshes (description evolving with SKILL.md).
  const metaTouched = input.display_name !== undefined || input.description !== undefined || input.tags !== undefined;
  const skill = metaTouched
    ? ((await db.skills.updateMeta(existing.id, {
        display_name: input.display_name,
        description: input.description,
        tags: input.tags,
      })) ?? existing)
    : ((await db.skills.getById(existing.id)) ?? existing);
  return { ok: true, created: false, skill: toSkillSummary(skill), version: toVersionSummary(versionRow) };
}

// ─── Read paths ──────────────────────────────────────────

export interface SkillDetail {
  skill: SkillSummary;
  versions: SkillVersionSummary[];
}

export async function getSkillDetail(db: DatabaseProvider, name: string): Promise<SkillDetail | null> {
  const skill = await db.skills.getByName(name);
  if (!skill) return null;
  const versions = await db.skills.listVersions(skill.id);
  return { skill: toSkillSummary(skill), versions: versions.map(toVersionSummary) };
}

export type DownloadResult =
  | { ok: true; skill: SkillSummary; version: SkillVersionSummary; files: SkillFile[] }
  | SkillError;

/** Fetch a version's files (latest by default). Archived skills stay downloadable — pinned installs must not break. */
export async function downloadSkill(db: DatabaseProvider, name: string, version?: string): Promise<DownloadResult> {
  const skill = await db.skills.getByName(name);
  if (!skill) return err('not_found', `Skill not found: "${name}"`);

  const wanted = version ?? skill.latest_version;
  const versionRow = await db.skills.getVersion(skill.id, wanted);
  if (!versionRow) return err('not_found', `Version ${wanted} of "${name}" not found`);

  const json = await getSkillStore().get(versionRow.storage_key);
  const bundle = json ? parseBundleJson(json) : null;
  if (!bundle) {
    logger.error(`[skills] bundle missing/corrupt in store: ${versionRow.storage_key}`);
    return err('not_found', `Bundle for ${name}@${wanted} is missing from the skill store — contact an admin`);
  }
  if (bundleContentHash(bundle.files) !== versionRow.content_hash) {
    logger.error(`[skills] bundle hash mismatch: ${versionRow.storage_key}`);
    return err('conflict', `Bundle for ${name}@${wanted} failed its integrity check — contact an admin`);
  }

  await db.skills.incrementDownloads(skill.id);
  return { ok: true, skill: toSkillSummary(skill), version: toVersionSummary(versionRow), files: bundle.files };
}

// ─── Sync check ──────────────────────────────────────────

export interface InstalledSkillRef {
  name: string;
  version: string;
}

export interface UpdateCheckEntry {
  name: string;
  status: 'up_to_date' | 'update_available' | 'not_found' | 'archived' | 'invalid_version';
  installed_version?: string;
  latest_version?: string;
  /** For update_available: the changelogs newer than the installed version, oldest first. */
  pending_changelogs?: { version: string; changelog: string; created_at: string }[];
}

export async function checkUpdates(db: DatabaseProvider, installed: InstalledSkillRef[]): Promise<UpdateCheckEntry[]> {
  const out: UpdateCheckEntry[] = [];
  for (const ref of installed) {
    const skill = await db.skills.getByName(ref.name);
    if (!skill) {
      out.push({ name: ref.name, status: 'not_found', installed_version: ref.version });
      continue;
    }
    if (!isValidSemver(ref.version)) {
      out.push({
        name: ref.name,
        status: 'invalid_version',
        installed_version: ref.version,
        latest_version: skill.latest_version,
      });
      continue;
    }
    if (skill.status === 'archived') {
      out.push({
        name: ref.name,
        status: 'archived',
        installed_version: ref.version,
        latest_version: skill.latest_version,
      });
      continue;
    }
    if (compareSemver(skill.latest_version, ref.version) <= 0) {
      out.push({
        name: ref.name,
        status: 'up_to_date',
        installed_version: ref.version,
        latest_version: skill.latest_version,
      });
      continue;
    }
    const versions = await db.skills.listVersions(skill.id);
    const pending = versions
      .filter((v) => isValidSemver(v.version) && compareSemver(v.version, ref.version) > 0)
      .sort((a, b) => compareSemver(a.version, b.version))
      .map((v) => ({ version: v.version, changelog: v.changelog, created_at: v.created_at }));
    out.push({
      name: ref.name,
      status: 'update_available',
      installed_version: ref.version,
      latest_version: skill.latest_version,
      pending_changelogs: pending,
    });
  }
  return out;
}

// ─── Manage ──────────────────────────────────────────────

export type ManageResult = { ok: true; skill: SkillSummary } | SkillError;

export async function updateSkillMeta(
  db: DatabaseProvider,
  actor: Actor,
  name: string,
  updates: { display_name?: string; description?: string; tags?: string[] },
): Promise<ManageResult> {
  const skill = await db.skills.getByName(name);
  if (!skill) return err('not_found', `Skill not found: "${name}"`);
  if (!canManage(actor, skill)) return err('forbidden', `Only the owner or a super admin can edit "${name}"`);
  if (updates.description !== undefined && !updates.description.trim()) {
    return err('invalid', 'description cannot be empty');
  }
  const updated = await db.skills.updateMeta(skill.id, updates);
  return { ok: true, skill: toSkillSummary(updated ?? skill) };
}

export async function setSkillStatus(
  db: DatabaseProvider,
  actor: Actor,
  name: string,
  status: 'active' | 'archived',
): Promise<ManageResult> {
  const skill = await db.skills.getByName(name);
  if (!skill) return err('not_found', `Skill not found: "${name}"`);
  if (!canManage(actor, skill)) {
    return err(
      'forbidden',
      `Only the owner or a super admin can ${status === 'archived' ? 'archive' : 'unarchive'} "${name}"`,
    );
  }
  const updated = await db.skills.setStatus(skill.id, status);
  return { ok: true, skill: toSkillSummary(updated ?? skill) };
}

export type DeleteResult = { ok: true; deleted_versions: number } | SkillError;

/** Hard delete — super only. Removes every stored bundle, then the rows (versions cascade). */
export async function deleteSkill(db: DatabaseProvider, actor: Actor, name: string): Promise<DeleteResult> {
  if (actor.role !== 'super') return err('forbidden', 'Only a super admin can permanently delete a skill');
  const skill = await db.skills.getByName(name);
  if (!skill) return err('not_found', `Skill not found: "${name}"`);

  const versions = await db.skills.listVersions(skill.id);
  for (const v of versions) {
    // Best-effort: a failed object delete must not block removal, but leave a trace.
    await getSkillStore()
      .delete(v.storage_key)
      .catch((e) => logger.warn(`[skills] failed to delete bundle ${v.storage_key}: ${String(e)}`));
  }
  await db.skills.remove(skill.id);
  return { ok: true, deleted_versions: versions.length };
}
