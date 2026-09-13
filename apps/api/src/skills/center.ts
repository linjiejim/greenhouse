/**
 * Skill Center orchestration — ONE implementation of publish / download /
 * sync-check / manage, shared by the HTTP routes (routes/skills.ts) and the
 * agent tools (tools/skills/*). Permission model (see the spec): reads for all
 * internal users; writes for the skill owner or a super; hard delete super-only.
 *
 * Results are discriminated unions with a `code` instead of thrown errors so
 * the routes can map codes to HTTP statuses and the tools can return the
 * message to the model as-is.
 *
 * `downloadSkill` is one function serving four consumers — the HTTP route, the
 * skill_query agent tool (chat / proxy / MCP), the cloud-agent sandbox sync and
 * the web Guide preview. That is why quarantine enforcement lives here and
 * nowhere else: gating this one call covers every surface at once
 * (docs/specs/20260805-skillhub-web-upload-and-scan.md).
 */

import { safeJsonParse } from '@greenhouse/utils/json';
import { bumpPatch, compareSemver, isValidSemver } from '@greenhouse/utils/semver';
import { logger } from '@greenhouse/utils/logger';
import type { DatabaseProvider, SkillRow, SkillScanStatus, SkillVersionRow } from '@greenhouse/db';
import {
  buildBundleJson,
  bundleContentHash,
  parseBundleJson,
  parseSkillMdFrontmatter,
  validateBundleFiles,
  validateSkillName,
  type SkillFile,
} from './bundle.js';
import { firstPartySkillGroup, isFirstPartySkill, type FirstPartySkillGroup } from './first-party.js';
import { isMissionReadySkill, isSlashSelectableSkill } from './mission-ready.js';
import { notifySuspiciousSkill } from './notify.js';
import { highFindings, scanBundle, type ScanFinding } from './scanner.js';
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
  scan_status: SkillScanStatus;
  scan_findings: ScanFinding[];
  scan_version: string | null;
  scanned_at: string | null;
  scan_reviewed_by: string | null;
  scan_reviewed_at: string | null;
  scan_note: string | null;
  /** Launchable as a Cloud Agent mission (the sandbox-sync predicate). */
  mission_ready: boolean;
  /** Trusted first-party repository group; null for user/team skills. */
  source_group: FirstPartySkillGroup | null;
  /** May be selected in Chat's slash picker and launched directly. */
  slash_selectable: boolean;
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
    scan_status: row.scan_status,
    scan_findings: safeJsonParse(row.scan_findings, []) as ScanFinding[],
    scan_version: row.scan_version,
    scanned_at: row.scanned_at,
    scan_reviewed_by: row.scan_reviewed_by,
    scan_reviewed_at: row.scan_reviewed_at,
    scan_note: row.scan_note,
    mission_ready: isMissionReadySkill(row),
    source_group: firstPartySkillGroup(row.name),
    slash_selectable: isSlashSelectableSkill(row),
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

/**
 * Failed-publish cleanup: delete the bundle we just put UNLESS a version row
 * now references its key — the losing side of a concurrent duplicate publish
 * shares the key with the winner, and deleting it would strand the winner's row.
 */
async function deleteBundleUnlessRegistered(
  db: DatabaseProvider,
  name: string,
  version: string,
  storageKey: string,
): Promise<void> {
  try {
    const skill = await db.skills.getByName(name);
    const row = skill ? await db.skills.getVersion(skill.id, version) : undefined;
    if (row?.storage_key === storageKey) return;
  } catch {
    // Can't tell — keep the bundle; an unreferenced object is harmless, a
    // missing referenced one is not.
    return;
  }
  await getSkillStore()
    .delete(storageKey)
    .catch(() => {});
}

/**
 * Scan the bundle and persist the verdict on the skill row. Runs inline in the
 * publish path rather than as a background job: the input is capped at 64 files
 * / 1 MiB, the rules are pure regex + magic bytes with no IO, so the cost is
 * sub-millisecond — while an async job would invent a `pending` window in which
 * "may an agent download this yet?" has no good answer (spec D1).
 */
/**
 * Scan a bundle without touching the database.
 *
 * Split out from {@link recordScan} so the publish path can run it BEFORE it
 * commits anything: `scanBundle` is pure and cheap, and a scanner that throws
 * (or a verdict write that fails) after the version row is committed used to
 * leave the skill on its `pending` default — which `downloadSkill` serves. The
 * whole premise of the feature is that nothing becomes downloadable unscanned,
 * so the report is computed up front and a failure to produce one is a refusal,
 * not a silently unscanned publish.
 */
function scanForPublish(
  name: string,
  files: SkillFile[],
  meta: { display_name: string; description: string; tags: string[] },
): { status: SkillScanStatus; findings: ScanFinding[] } {
  // `trusted` is deliberately NOT taken from the caller's tags — see first-party.ts.
  const report = scanBundle(files, { name, ...meta });
  return { status: isFirstPartySkill(name) ? 'clean' : report.status, findings: report.findings };
}

async function recordScan(
  db: DatabaseProvider,
  skill: SkillRow,
  version: string,
  report: { status: SkillScanStatus; findings: ScanFinding[] },
): Promise<SkillRow> {
  const trusted = isFirstPartySkill(skill.name);
  // Guarded on `version`: two concurrent publishes of the same skill would
  // otherwise let an older bundle's `clean` verdict land last and clear the
  // quarantine a newer, higher-version bundle had just earned.
  const updated = await db.skills.setScanResult(skill.id, {
    status: report.status,
    findings: report.findings,
    version,
    onlyIfLatestVersion: version,
  });

  const high = highFindings(report.findings);
  if (high.length > 0) {
    const rules = [...new Set(high.map((f) => f.rule))].join(', ');
    if (trusted) {
      logger.warn(
        `[skills] first-party pack ${skill.name}@${version} matched scanner rules (not quarantined): ${rules}`,
      );
    } else {
      logger.warn(`[skills] quarantined ${skill.name}@${version} — matched: ${rules}`);
      await notifySuspiciousSkill({ skill: updated ?? skill, version, findings: high });
    }
  }
  return updated ?? skill;
}

export async function publishSkill(db: DatabaseProvider, actor: Actor, input: PublishInput): Promise<PublishResult> {
  const nameError = validateSkillName(input.name ?? '');
  if (nameError) return err('invalid', nameError);
  if (isFirstPartySkill(input.name) && actor.role !== 'super') {
    return err('forbidden', `Skill name "${input.name}" is reserved for repository-managed first-party content`);
  }

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

    // Scan BEFORE anything is committed: a scanner that throws after the version
    // row exists used to leave the skill on its `pending` default, which
    // `downloadSkill` serves — i.e. an unscanned bundle, downloadable.
    const display = input.display_name?.trim() || input.name;
    let report: { status: SkillScanStatus; findings: ScanFinding[] };
    try {
      report = scanForPublish(input.name, files, {
        display_name: display,
        description,
        tags: input.tags ?? [],
      });
    } catch (error) {
      logger.error(`[skills] scan failed for ${input.name}@${version}: ${String(error)}`);
      return err('invalid', 'Security scan could not be completed for this bundle — publish refused');
    }

    const storageKey = storageKeyFor(input.name, version);
    await getSkillStore().put(storageKey, buildBundleJson(input.name, version, files));
    let created: SkillRow;
    let versionRow: SkillVersionRow;
    try {
      created = await db.skills.create(
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
      versionRow = (await db.skills.getVersion(created.id, version))!;
    } catch {
      // Likely a concurrent create of the same name. Clean up the orphan bundle —
      // but only if the winner didn't register this exact key (same version ⇒ same
      // key; deleting it would strand the winner's version row).
      await deleteBundleUnlessRegistered(db, input.name, version, storageKey);
      return err('conflict', `Skill "${input.name}" already exists (or create failed) — retry as an update`);
    }
    // Scanning sits OUTSIDE the try: a scanner/DB failure here is not a
    // concurrent-create conflict and must not delete the freshly stored bundle.
    const scanned = await recordScan(db, created, version, report);
    return { ok: true, created: true, skill: toSkillSummary(scanned), version: toVersionSummary(versionRow) };
  }

  // ── Update path (new version of an existing skill) ──
  if (!canManage(actor, existing)) {
    return err('forbidden', `Only the owner of "${existing.name}" (or a super admin) can publish new versions`);
  }
  if (existing.status === 'archived') {
    return err('conflict', `Skill "${existing.name}" is archived — unarchive it before publishing`);
  }
  // `blocked` is sticky. Without this, "banned → change one word → republish"
  // clears the verdict and the ban means nothing; lifting it is a super's
  // explicit ruling and nothing else (spec D6).
  if (existing.scan_status === 'blocked') {
    return err(
      'conflict',
      `Skill "${existing.name}" was reviewed and confirmed malicious — publishing is blocked. A super admin must clear it first.`,
    );
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
    // Same guard as the create path: a concurrent publish of the same version
    // (e.g. an agent retry) shares this key — deleting it would break the winner.
    await deleteBundleUnlessRegistered(db, existing.name, version, storageKey);
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

  // A new version re-decides the verdict for the whole skill: a previously
  // clean skill can turn suspicious, and a suspicious one goes clean once the
  // author fixes it and republishes.
  const scanned = await recordScan(
    db,
    skill,
    version,
    scanForPublish(skill.name, files, {
      display_name: skill.display_name,
      description: skill.description,
      tags: safeJsonParse(skill.tags, []) as string[],
    }),
  );
  return { ok: true, created: false, skill: toSkillSummary(scanned), version: toVersionSummary(versionRow) };
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

/**
 * Who may pull a quarantined skill's bytes.
 *
 * fail-closed by default: a caller that passes no actor (the cloud-agent sandbox
 * sync) is treated as an ordinary member, which is the strictest bucket and
 * exactly what we want for an unattended consumer.
 *
 * Clean third-party content still requires an explicit super review before it
 * may reach other users or unattended sandboxes. The regex scanner is a useful
 * signal, not a proof that natural-language instructions are safe.
 */
function quarantineError(scan: SkillScanStatus, skill: SkillRow, actor?: Actor): SkillError | null {
  const isSuper = actor?.role === 'super';
  const isOwner = actor !== undefined && skill.owner_user_id === actor.userId;
  if (scan === 'clean') {
    if (isFirstPartySkill(skill.name) || skill.scan_reviewed_by || isSuper || isOwner) return null;
    return err('forbidden', `Skill "${skill.name}" requires security review before team-wide download.`);
  }
  if (scan === 'pending') {
    if (isSuper || isOwner) return null;
    return err('forbidden', `Skill "${skill.name}" has not completed security review.`);
  }

  if (scan === 'blocked') {
    // Super only — a confirmed-malicious bundle still has to be inspectable.
    if (isSuper) return null;
    return err('forbidden', `Skill "${skill.name}" was confirmed malicious and is blocked from download.`);
  }
  // suspicious — the owner needs it to fix and republish, a super to review it.
  if (isSuper || isOwner) return null;
  return err(
    'forbidden',
    `Skill "${skill.name}" is pending security review and cannot be downloaded yet. A super admin must clear it.`,
  );
}

/**
 * Fetch a version's files (latest by default). Archived skills stay downloadable — pinned installs must not break.
 *
 * `opts.meter === false` skips the download counter — used by the web browse UI,
 * which pulls bundles just to render SKILL.md / preview files. Only real installs
 * (agent skill_query download, explicit human "Download ZIP") should count.
 *
 * `opts.actor` decides quarantine access (see quarantineError). Callers that
 * omit it get the strictest treatment — quarantine gating is fail-closed.
 * `opts.bypassQuarantine` is for the scanner's own re-read (rescan / boot
 * sweep), which must be able to fetch a bundle in order to judge it.
 */
export async function downloadSkill(
  db: DatabaseProvider,
  name: string,
  version?: string,
  opts?: { meter?: boolean; actor?: Actor; bypassQuarantine?: boolean },
): Promise<DownloadResult> {
  const skill = await db.skills.getByName(name);
  if (!skill) return err('not_found', `Skill not found: "${name}"`);

  if (!opts?.bypassQuarantine) {
    const blocked = quarantineError(skill.scan_status, skill, opts?.actor);
    if (blocked) return blocked;
  }

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

  if (opts?.meter !== false) await db.skills.incrementDownloads(skill.id);
  return { ok: true, skill: toSkillSummary(skill), version: toVersionSummary(versionRow), files: bundle.files };
}

// ─── Sync check ──────────────────────────────────────────

export interface InstalledSkillRef {
  name: string;
  version: string;
}

export interface UpdateCheckEntry {
  name: string;
  /**
   * `quarantined` short-circuits the others: a client told `update_available`
   * for a skill whose download is guaranteed to be refused would just retry
   * forever.
   */
  status: 'up_to_date' | 'update_available' | 'not_found' | 'archived' | 'invalid_version' | 'quarantined';
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
    if (quarantineError(skill.scan_status, skill)) {
      out.push({
        name: ref.name,
        status: 'quarantined',
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
  const bundle = await downloadSkill(db, name, skill.latest_version, { meter: false, bypassQuarantine: true });
  if (!bundle.ok) return bundle;
  const prospective = {
    display_name: updates.display_name ?? skill.display_name,
    description: updates.description ?? skill.description,
    tags: updates.tags ?? (safeJsonParse(skill.tags, []) as string[]),
  };
  let report: { status: SkillScanStatus; findings: ScanFinding[] };
  try {
    report = scanForPublish(skill.name, bundle.files, prospective);
  } catch (error) {
    logger.error(`[skills] metadata scan failed for ${name}@${skill.latest_version}: ${String(error)}`);
    return err('invalid', 'Security scan could not be completed for this metadata change');
  }
  const updated = await db.skills.updateMetaWithScan(skill.id, updates, {
    ...report,
    version: skill.latest_version,
  });
  if (!updated) return err('conflict', `Skill "${name}" changed concurrently — retry the metadata update`);
  const high = highFindings(report.findings);
  if (high.length > 0 && !isFirstPartySkill(skill.name)) {
    await notifySuspiciousSkill({ skill: updated, version: skill.latest_version, findings: high });
  }
  return { ok: true, skill: toSkillSummary(updated) };
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

// ─── Security review (super only) ────────────────────────

/**
 * Rule on a scanner verdict. `clean` restores downloads immediately; `blocked`
 * is the permanent ban — it locks out the owner as well and makes republishing
 * a 409, so only a super can ever undo it.
 */
export async function decideSkillScan(
  db: DatabaseProvider,
  actor: Actor,
  name: string,
  decision: 'clean' | 'blocked',
  note?: string,
): Promise<ManageResult> {
  if (actor.role !== 'super') return err('forbidden', 'Only a super admin can rule on a security scan');
  const skill = await db.skills.getByName(name);
  if (!skill) return err('not_found', `Skill not found: "${name}"`);

  const updated = await db.skills.setScanDecision(skill.id, {
    status: decision,
    reviewed_by: actor.userId,
    note: note?.trim() || undefined,
  });
  logger.info(`[skills] scan decision ${decision} for ${name} by ${actor.userId}`);
  return { ok: true, skill: toSkillSummary(updated ?? skill) };
}

/**
 * Re-run the scanner over the latest version. Used before an author republishes
 * ("did my fix clear it?") and as the manual entry point for the boot sweep.
 * Reads the bundle with `bypassQuarantine` — judging a quarantined skill
 * obviously requires reading it.
 */
export async function rescanSkill(db: DatabaseProvider, actor: Actor, name: string): Promise<ManageResult> {
  if (actor.role !== 'super') return err('forbidden', 'Only a super admin can trigger a rescan');
  const skill = await db.skills.getByName(name);
  if (!skill) return err('not_found', `Skill not found: "${name}"`);

  const bundle = await downloadSkill(db, name, skill.latest_version, { meter: false, bypassQuarantine: true });
  if (!bundle.ok) return bundle;

  const scanned = await recordScan(
    db,
    skill,
    skill.latest_version,
    scanForPublish(skill.name, bundle.files, {
      display_name: skill.display_name,
      description: skill.description,
      tags: safeJsonParse(skill.tags, []) as string[],
    }),
  );
  return { ok: true, skill: toSkillSummary(scanned) };
}

/**
 * Backfill verdicts for rows that predate the scanner (`scanned_at IS NULL`).
 * Fire-and-forget at boot alongside the other boot sweeps: never fatal, never
 * blocks the health gate. This is the ONLY genuinely asynchronous scanning in
 * the system — publishing scans inline (spec D1).
 */
export async function sweepUnscannedSkills(db: DatabaseProvider, limit = 200): Promise<number> {
  try {
    const pending = await db.skills.listUnscanned(limit);
    if (pending.length === 0) return 0;

    let scanned = 0;
    for (const skill of pending) {
      try {
        const bundle = await downloadSkill(db, skill.name, skill.latest_version, {
          meter: false,
          bypassQuarantine: true,
        });
        if (!bundle.ok) {
          logger.warn(`[skills] backfill scan skipped for ${skill.name}: ${bundle.error}`);
          continue;
        }
        // Repo-owned packs are re-seeded as trusted on every boot; treat them
        // the same here so a backfill can't quarantine a first-party skill.
        // Trust comes from the repo listing, never from the (editable) tag.
        const tags = safeJsonParse(skill.tags, []) as string[];
        await recordScan(
          db,
          skill,
          skill.latest_version,
          scanForPublish(skill.name, bundle.files, {
            display_name: skill.display_name,
            description: skill.description,
            tags,
          }),
        );
        scanned += 1;
      } catch (error) {
        logger.warn(`[skills] backfill scan failed for ${skill.name}: ${String(error)}`);
      }
    }
    if (scanned > 0) logger.info(`[skills] backfill scan complete — ${scanned}/${pending.length} skills scanned`);
    return scanned;
  } catch (error) {
    logger.error(`[skills] backfill scan sweep failed (boot continues): ${String(error)}`);
    return 0;
  }
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
