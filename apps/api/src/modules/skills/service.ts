/**
 * The skill library (SKL-01…SKL-10): SKILL.md packages and templates, in the team space for
 * every member or the personal space of their owner; immutable versions; the security scan and
 * its review; whether a skill can run for an Agent; running one with `/`; and the official
 * skills of skillhub/. Routes and the skill tools call this one service.
 *
 * Who does what:
 * - Any member may add a skill to either space (as v1 let anyone publish); its owner, or an
 *   admin for a team skill, changes it, adds versions, archives and restores it.
 * - Review (mark safe, confirm malicious): an admin for a team skill; the owner for a personal
 *   one, which nobody else sees. Anyone who may change a skill may have it scanned again.
 * - Only clean skills run. A team skill that is not clean is seen only by its owner and admins.
 * - A skill runs for an Agent only when that Agent meets its requirements: a computer, the
 *   connectors it names (usable for the member). The same check guards `/` and equipping.
 */

import { createHash } from 'node:crypto';
import { and, desc, eq, ilike, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  AgentManifest,
  Page,
  Skill as SkillView,
  SkillDetail,
  SkillDownload,
  SkillRequirements,
  SkillStarters,
  SkillUnavailable,
  SkillVariable,
  SkillVersion as SkillVersionView,
  UpdateSkillInput,
  createSkillInputSchema,
  newSkillVersionInputSchema,
  skillListQuerySchema,
  skillScanDecisionInputSchema,
} from '@greenhouse/contract';
import {
  getDb,
  members,
  messages,
  newId,
  skills,
  skillVersions,
  transaction,
  type Skill as SkillRow,
  type SkillVersion as VersionRow,
} from '@greenhouse/db';
import { agentTemplate, MAIN_AGENT_TEMPLATE } from '@greenhouse/types/agent-templates';
import { isUniqueViolation, toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { bumpPatch, compareSemver } from '@greenhouse/utils/semver';
import { audit } from '../../audit.js';
import { ApiError, conflict, forbidden, invalidInput, notFound } from '../../http/errors.js';
import { containing } from '../../http/like.js';
import { decodeCursor, toPage } from '../../http/pagination.js';
import type { ProvidersService } from '../../providers/service.js';
import type { AgentsService } from '../agents/service.js';
import type { ComputersService } from '../computers/service.js';
import type { ConnectorsService } from '../connectors/service.js';
import type { FilesService } from '../files/service.js';
import { effectiveModules } from '../members/service.js';
import type { NotificationsService } from '../notifications/service.js';
import { bundleHeld, visibleTo, type SkillActor } from './access.js';
import { installOnComputer } from './computer.js';
import {
  PACKAGE_LIMITS,
  PackageError,
  packageFilename,
  packageZip,
  readPackage,
  readPackageZip,
  textOf,
  type PackageFile,
  type SkillPackage,
} from './package.js';
import { scanPackage, scanTemplate, type ScanReport } from './scan.js';
import { changelogEntry, collectPacks, readPackFiles, SKILLHUB_DIR } from './seed.js';
import { checkValues, variablesProblem } from './template.js';
import { han } from '@greenhouse/utils/i18n';

type ListQuery = z.output<typeof skillListQuerySchema>;
type CreateInput = z.output<typeof createSkillInputSchema>;
type TemplateInput = Extract<CreateInput, { kind: 'template' }>;
type PackageInput = Extract<CreateInput, { kind: 'package' }>;
type VersionInput = z.output<typeof newSkillVersionInputSchema>;
type ScanDecision = z.output<typeof skillScanDecisionInputSchema>;

/** Only skills that ship with Greenhouse carry it; members cannot set it. */
export const OFFICIAL_TAG = 'official';
const OFFICIAL_NOTE = 'Ships with Greenhouse (skillhub/).';
const FIRST_VERSION = '1.0.0';
/** A file read into a turn; the rest is cut. */
const READ_FILE_MAX_CHARS = 50_000;
/** Text the skill tools show of a description. */
const BRIEF_MAX = 200;

/** What an Agent can do for the member right now, for judging requirements. */
export interface RunContext {
  computer: boolean;
  connectors: ReadonlySet<string>;
}

/** A skill in an Agent's list: equipped or found, with why it cannot run. */
export interface AgentSkill {
  id: string;
  name: string;
  displayName: string;
  description: string;
  kind: SkillRow['kind'];
  unavailable: SkillUnavailable | null;
}

/**
 * The Agent a skill would run for: its manifest, and for someone else's public Agent whether its
 * publication grants the asker a computer (a TurnAgent is one).
 */
export interface SkillAgent {
  manifest: AgentManifest;
  public: { computer: boolean } | null;
  /** A background run: no computer there. */
  background?: boolean;
}

/** What `skill_mutation` proposes; saved as a template only when the member accepts. */
export type TemplateProposal = Omit<TemplateInput, 'kind' | 'version' | 'changelog'>;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** JSON with sorted keys: the same template always hashes the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const templateHash = (input: { body: string; variables: SkillVariable[]; requirements: SkillRequirements }) =>
  sha256(stable(input));

const requirementsOf = (row: Pick<SkillRow, 'requirements'>): SkillRequirements => ({
  computer: row.requirements.computer ?? false,
  connectors: row.requirements.connectors ?? [],
});

/** Real tags only: `<placeholder>` in a description is not markup. */
const HTML_TAG = /<\s*\/?\s*(?:script|iframe|img|svg|object|embed|link|style|meta|html|body|div|span|a)\b/i;
// eslint-disable-next-line no-control-regex -- control characters are what this refuses
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Catalog text is shown everywhere: no markup, no control characters. */
function checkText(label: string, value: string | undefined) {
  if (value && (HTML_TAG.test(value) || CONTROL.test(value))) {
    throw invalidInput(`${label} cannot contain HTML or control characters.`);
  }
}

function checkTags(tags: readonly string[] | undefined) {
  for (const tag of tags ?? []) {
    checkText('A tag', tag);
    if (tag.toLowerCase() === OFFICIAL_TAG) {
      throw invalidInput(`The tag "${OFFICIAL_TAG}" is kept for the skills that ship with Greenhouse.`);
    }
  }
}

/** Why a skill cannot run at all, whatever the Agent. */
export function blockedReason(row: SkillRow): SkillUnavailable | null {
  if (row.archivedAt) return { code: 'archived', message: `${row.name} is archived.` };
  if (row.scanStatus === 'blocked') {
    return { code: 'blocked', message: `${row.name} was confirmed malicious and never runs.` };
  }
  if (row.scanStatus !== 'clean') {
    return { code: 'in_review', message: `${row.name} waits for review of its security scan.` };
  }
  return null;
}

/** Why a skill cannot run for an Agent that can do what `ctx` says, or null. */
export function unavailableFor(row: SkillRow, ctx: RunContext): SkillUnavailable | null {
  const fixed = blockedReason(row);
  if (fixed) return fixed;
  const needs = requirementsOf(row);
  if (needs.computer && !ctx.computer) {
    return { code: 'needs_computer', message: `${row.name} needs a computer, which this Agent does not have here.` };
  }
  const missing = needs.connectors.find((slug) => !ctx.connectors.has(slug));
  if (missing) {
    return {
      code: 'needs_connector',
      message: `${row.name} needs the connector "${missing}", which this Agent cannot use for you.`,
      connector: missing,
    };
  }
  return null;
}

const toVersion = (row: VersionRow): SkillVersionView => ({
  version: row.version,
  changelog: row.changelog,
  sha256: row.sha256,
  file_count: row.fileCount,
  size_bytes: row.sizeBytes,
  created_by: row.createdBy,
  created_at: row.createdAt,
});

export function createSkillsService(deps: {
  files: FilesService;
  providers: ProvidersService;
  agents: AgentsService;
  connectors: ConnectorsService;
  computers: ComputersService;
  notifications: NotificationsService;
}) {
  const canManage = (actor: SkillActor, row: SkillRow) =>
    row.ownerId === actor.id || (row.space === 'team' && actor.role === 'admin');
  const canReview = (actor: SkillActor, row: SkillRow) =>
    row.space === 'team' ? actor.role === 'admin' : row.ownerId === actor.id;

  function toSkill(
    row: SkillRow,
    actor: SkillActor,
    variables: SkillVariable[],
    unavailable: SkillUnavailable | null,
  ): SkillView {
    return {
      id: row.id,
      name: row.name,
      display_name: row.displayName || row.name,
      description: row.description,
      kind: row.kind,
      space: row.space,
      owner_id: row.ownerId,
      tags: row.tags,
      latest_version: row.latestVersion,
      requirements: requirementsOf(row),
      variables,
      scan_status: row.scanStatus,
      scan_findings: row.scanFindings,
      scanned_at: row.scannedAt,
      scan_reviewed_by: row.scanReviewedBy,
      scan_note: row.scanNote,
      download_count: row.downloadCount,
      archived_at: row.archivedAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      can_manage: canManage(actor, row),
      can_review: canReview(actor, row),
      available: !unavailable,
      unavailable,
    };
  }

  async function actorOf(memberId: string): Promise<SkillActor> {
    const [row] = await getDb()
      .select({ id: members.id, role: members.role })
      .from(members)
      .where(eq(members.id, memberId));
    if (!row) throw notFound('Member');
    return row;
  }

  /** What an Agent can do for the member: its computer (when it has one here) and usable connectors. */
  async function contextFor(
    memberId: string,
    manifest: Pick<AgentManifest, 'connectors' | 'write'>,
    opts: { computer: boolean; publicAgent: boolean },
  ): Promise<RunContext> {
    // Someone else's public Agent never reaches the asker's connectors (engine/AGENTS.md).
    const usable = opts.publicAgent ? [] : await deps.connectors.usable(memberId, manifest);
    return { computer: opts.computer, connectors: new Set(usable.map((connector) => connector.slug)) };
  }

  /** The same, for an Agent as a turn loads it: computers on for the member, a sandbox set up. */
  async function runContext(memberId: string, loaded: SkillAgent): Promise<RunContext> {
    const [member] = await getDb().select({ modules: members.modules }).from(members).where(eq(members.id, memberId));
    const computer =
      !!member &&
      !loaded.background &&
      effectiveModules(member.modules).computer === true &&
      (!loaded.public || loaded.public.computer) &&
      (await deps.providers.available('sandbox', { memberId, personal: false }));
    return contextFor(memberId, loaded.manifest, { computer, publicAgent: !!loaded.public });
  }

  async function visibleRow(actor: SkillActor, id: string): Promise<SkillRow> {
    const [row] = await getDb()
      .select()
      .from(skills)
      .where(and(eq(skills.id, id), visibleTo(actor)));
    if (!row) throw notFound('Skill');
    return row;
  }

  async function manageableRow(actor: SkillActor, id: string): Promise<SkillRow> {
    const row = await visibleRow(actor, id);
    if (!canManage(actor, row)) throw forbidden('Only its owner, or an admin for a team skill, can change it.');
    return row;
  }

  async function versionOf(skillId: string, version: string): Promise<VersionRow> {
    const [row] = await getDb()
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)));
    if (!row) throw notFound('Skill version');
    return row;
  }

  /** A skill by id, or by name among those the member sees: their personal one before the team's. */
  async function byReference(actor: SkillActor, ref: string): Promise<SkillRow | null> {
    const rows = await getDb()
      .select()
      .from(skills)
      .where(and(or(eq(skills.id, ref), eq(skills.name, ref.trim().toLowerCase())), visibleTo(actor)));
    return (
      rows.find((row) => row.id === ref) ??
      rows.find((row) => row.space === 'personal') ??
      rows.find((row) => row.space === 'team') ??
      null
    );
  }

  async function detail(actor: SkillActor, row: SkillRow, unavailable: SkillUnavailable | null) {
    const version = await versionOf(row.id, row.latestVersion);
    const view: SkillDetail = {
      ...toSkill(row, actor, version.variables, unavailable),
      body: version.body,
      files: version.files,
      version: toVersion(version),
    };
    return view;
  }

  /** `available` is judged for the main Agent when no other Agent is named. */
  async function mainContext(actor: SkillActor): Promise<RunContext> {
    return runContext(actor.id, await deps.agents.loadForTurn(actor.id, 'main'));
  }

  async function mainDetail(actor: SkillActor, row: SkillRow) {
    return detail(actor, row, unavailableFor(row, await mainContext(actor)));
  }

  async function mainView(actor: SkillActor, row: SkillRow): Promise<SkillView> {
    const latest = await versionOf(row.id, row.latestVersion);
    return toSkill(row, actor, latest.variables, unavailableFor(row, await mainContext(actor)));
  }

  async function assertNameFree(space: SkillRow['space'], ownerId: string, name: string) {
    const [taken] = await getDb()
      .select({ id: skills.id })
      .from(skills)
      .where(
        and(
          eq(skills.name, name),
          space === 'team' ? eq(skills.space, 'team') : and(eq(skills.space, 'personal'), eq(skills.ownerId, ownerId)),
        ),
      );
    if (taken) throw nameTaken(space, name);
  }

  const nameTaken = (space: SkillRow['space'], name: string) =>
    conflict(
      'skill_name_taken',
      space === 'team'
        ? `There is already a team skill called "${name}".`
        : `You already have a skill called "${name}".`,
    );

  /** A new version string: given, else SKILL.md's, else the next patch; always above the latest. */
  function nextVersion(latest: string, given: string | undefined | null): string {
    const version = given ?? bumpPatch(latest);
    if (compareSemver(version, latest) <= 0) {
      throw conflict('version_not_newer', `The new version must be higher than ${latest}.`);
    }
    return version;
  }

  /** The verdict columns: the scan's, or clean for what ships in the repository. */
  const verdict = (report: ScanReport, official = false) => ({
    scanStatus: official ? ('clean' as const) : report.status,
    scanFindings: report.findings,
    scannedAt: new Date().toISOString(),
    scanReviewedBy: null,
    scanNote: official ? OFFICIAL_NOTE : null,
  });

  /** Someone must look at a team skill the scan holds: every admin but the one who uploaded it. */
  async function askForReview(row: SkillRow, actorId: string) {
    if (row.space !== 'team' || row.scanStatus === 'clean' || row.scanStatus === 'blocked') return;
    const admins = await getDb()
      .select({ id: members.id, locale: members.locale })
      .from(members)
      .where(and(eq(members.role, 'admin'), eq(members.status, 'active'), ne(members.id, actorId)));
    const title = row.displayName || row.name;
    for (const admin of admins) {
      await deps.notifications.publish({
        memberId: admin.id,
        kind: 'skill_scan',
        title:
          admin.locale === 'en'
            ? `The security scan holds the skill "${title}" for review`
            : han`技能「${title}」的安全扫描需要审核`,
        targetType: 'skill',
        targetId: row.id,
        payload: { category: 'skill_scan', status: row.scanStatus },
        dedupeKey: `skill_scan:${row.id}:${row.latestVersion}`,
      });
    }
  }

  /** The uploaded ZIP a package is made from: the member's own fresh upload with purpose `skill`. */
  async function uploadedZip(memberId: string, fileId: string) {
    const { row, bytes } = await deps.files.bytes(memberId, fileId);
    if (row.ownerId !== memberId || row.purpose !== 'skill') {
      throw invalidInput('Upload the ZIP with purpose "skill" first.');
    }
    if (await bundleHeld(fileId)) throw invalidInput('That file already belongs to a skill; upload the ZIP again.');
    if (bytes.byteLength > PACKAGE_LIMITS.zipBytes) throw invalidInput('The ZIP is larger than 10 MB.');
    return { row, bytes };
  }

  function readZip(bytes: Uint8Array): SkillPackage {
    try {
      return readPackageZip(bytes);
    } catch (error) {
      if (error instanceof PackageError) throw new ApiError(400, 'invalid_package', error.message);
      throw error;
    }
  }

  /** Stores a version's canonical ZIP through the file service, owned by who added the version. */
  async function storeBundle(memberId: string, pkg: SkillPackage, version: string) {
    return deps.files.store(memberId, {
      name: packageFilename(pkg.name, version),
      contentType: 'application/zip',
      bytes: packageZip(pkg.name, pkg.files),
      purpose: 'skill',
    });
  }

  /** A package's files, read back from its stored ZIP (checked against the version's hash). */
  async function packageFiles(memberId: string, version: VersionRow): Promise<PackageFile[]> {
    if (!version.bundleFileId) throw conflict('not_a_package', 'This skill has no files.');
    const { bytes } = await deps.files.bytes(memberId, version.bundleFileId);
    const pkg = readPackageZip(bytes);
    if (pkg.sha256 !== version.sha256) {
      logger.error('[skills] a stored package does not match its hash', { version: version.id });
      throw new ApiError(500, 'skill_corrupt', 'This version of the skill is damaged; ask an admin.');
    }
    return pkg.files;
  }

  /** Inserts a skill and its first version in one transaction; a lost race on the name answers 409. */
  async function insertSkill(
    values: typeof skills.$inferInsert,
    version: Omit<typeof skillVersions.$inferInsert, 'skillId' | 'id'>,
  ) {
    try {
      return await transaction(async (db) => {
        const [row] = await db.insert(skills).values(values).returning();
        await db.insert(skillVersions).values({ id: newId('skillVersion'), skillId: row!.id, ...version });
        return row!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken(values.space, values.name);
      throw error;
    }
  }

  async function createTemplate(actor: SkillActor, input: Omit<TemplateInput, 'kind'>): Promise<SkillRow> {
    checkText('The display name', input.display_name);
    checkText('The description', input.description);
    checkTags(input.tags);
    const problem = variablesProblem(input.body, input.variables);
    if (problem) throw invalidInput(problem);
    await assertNameFree(input.space, actor.id, input.name);
    const requirements = { computer: input.requirements.computer, connectors: input.requirements.connectors };
    const row = await insertSkill(
      {
        id: newId('skill'),
        name: input.name,
        displayName: input.display_name ?? '',
        description: input.description,
        kind: 'template',
        space: input.space,
        ownerId: actor.id,
        tags: input.tags ?? [],
        latestVersion: input.version ?? FIRST_VERSION,
        requirements,
        ...verdict(scanTemplate({ body: input.body, variables: input.variables })),
      },
      {
        version: input.version ?? FIRST_VERSION,
        changelog: input.changelog || 'First version',
        variables: input.variables,
        body: input.body,
        sha256: templateHash({ body: input.body, variables: input.variables, requirements }),
        createdBy: actor.id,
      },
    );
    await askForReview(row, actor.id);
    return row;
  }

  async function createPackage(
    actor: SkillActor,
    input: Omit<PackageInput, 'kind' | 'file_id'>,
    pkg: SkillPackage,
    options: { official?: boolean; tags?: string[] } = {},
  ): Promise<SkillRow> {
    checkText('The display name', pkg.displayName);
    checkText('The description', pkg.description);
    if (!options.official) checkTags(input.tags);
    const version = input.version ?? pkg.version ?? FIRST_VERSION;
    await assertNameFree(input.space, actor.id, pkg.name);
    const report = scanPackage(pkg.files);
    const stored = await storeBundle(actor.id, pkg, version);
    try {
      const row = await insertSkill(
        {
          id: newId('skill'),
          name: pkg.name,
          displayName: pkg.displayName,
          description: pkg.description,
          kind: 'package',
          space: input.space,
          ownerId: actor.id,
          tags: options.tags ?? input.tags ?? pkg.tags.filter((tag) => tag.toLowerCase() !== OFFICIAL_TAG),
          latestVersion: version,
          requirements: pkg.requirements,
          ...verdict(report, options.official),
        },
        {
          version,
          changelog: input.changelog || 'First version',
          body: pkg.body,
          bundleFileId: stored.id,
          files: pkg.files.map((file) => ({ path: file.path, size: file.bytes.byteLength })),
          fileCount: pkg.files.length,
          sizeBytes: pkg.sizeBytes,
          sha256: pkg.sha256,
          createdBy: actor.id,
        },
      );
      await askForReview(row, actor.id);
      return row;
    } catch (error) {
      await deps.files.discard(stored.id);
      throw error;
    }
  }

  /** Appends a version to a skill the actor manages; the scan's verdict becomes the skill's. */
  async function appendVersion(
    actor: SkillActor,
    row: SkillRow,
    input: VersionInput,
    pkg: SkillPackage | null,
    options: { official?: boolean } = {},
  ): Promise<SkillRow> {
    if (row.archivedAt) throw conflict('skill_archived', 'Restore this skill before adding a version.');
    if (row.scanStatus === 'blocked') {
      throw conflict('skill_blocked', 'This skill was confirmed malicious; its reviewer must clear it first.');
    }
    const latest = await versionOf(row.id, row.latestVersion);
    let values: Omit<typeof skillVersions.$inferInsert, 'id' | 'skillId' | 'version' | 'changelog' | 'createdBy'>;
    let skill: Partial<typeof skills.$inferInsert>;
    let report: ScanReport;
    let version: string;
    if (row.kind === 'package') {
      if (!pkg) throw invalidInput('Upload the new ZIP and give its file_id.');
      if (pkg.name !== row.name) {
        throw new ApiError(400, 'invalid_package', `This package is called "${pkg.name}", not "${row.name}".`);
      }
      checkText('The display name', pkg.displayName);
      checkText('The description', pkg.description);
      version = nextVersion(row.latestVersion, input.version ?? pkg.version);
      if (pkg.sha256 === latest.sha256) throw conflict('nothing_changed', `This is the same as ${row.latestVersion}.`);
      report = scanPackage(pkg.files);
      values = {
        body: pkg.body,
        files: pkg.files.map((file) => ({ path: file.path, size: file.bytes.byteLength })),
        fileCount: pkg.files.length,
        sizeBytes: pkg.sizeBytes,
        sha256: pkg.sha256,
      };
      skill = { displayName: pkg.displayName, description: pkg.description, requirements: pkg.requirements };
    } else {
      if (input.file_id) throw invalidInput('A template has no files; send its body and fields.');
      const body = input.body ?? latest.body;
      const variables = input.variables ?? latest.variables;
      const requirements = input.requirements ?? requirementsOf(row);
      const problem = variablesProblem(body, variables);
      if (problem) throw invalidInput(problem);
      const sha = templateHash({ body, variables, requirements });
      if (sha === latest.sha256) throw conflict('nothing_changed', `This is the same as ${row.latestVersion}.`);
      version = nextVersion(row.latestVersion, input.version);
      report = scanTemplate({ body, variables });
      values = { body, variables, sha256: sha };
      skill = { requirements };
    }
    const stored = pkg ? await storeBundle(actor.id, pkg, version) : null;
    try {
      const updated = await transaction(async (db) => {
        await db.insert(skillVersions).values({
          id: newId('skillVersion'),
          skillId: row.id,
          version,
          changelog: input.changelog,
          createdBy: actor.id,
          ...values,
          ...(stored ? { bundleFileId: stored.id } : {}),
        });
        const [saved] = await db
          .update(skills)
          .set({ ...skill, latestVersion: version, ...verdict(report, options.official), updatedAt: sql`now()` })
          .where(and(eq(skills.id, row.id), eq(skills.latestVersion, row.latestVersion)))
          .returning();
        if (!saved) throw conflict('skill_changed', 'Someone added a version meanwhile; reload and try again.');
        return saved;
      });
      await askForReview(updated, actor.id);
      return updated;
    } catch (error) {
      if (stored) await deps.files.discard(stored.id);
      if (isUniqueViolation(error)) throw conflict('version_exists', `Version ${version} already exists.`);
      throw error;
    }
  }

  /** The latest version's content as the scanner reads it. */
  async function rescanReport(actorId: string, row: SkillRow): Promise<ScanReport> {
    const version = await versionOf(row.id, row.latestVersion);
    return row.kind === 'package'
      ? scanPackage(await packageFiles(actorId, version))
      : scanTemplate({ body: version.body, variables: version.variables });
  }

  const service = {
    async list(actor: SkillActor, query: ListQuery): Promise<Page<SkillView>> {
      const before = decodeCursor(query.cursor);
      const q = query.q ? containing(query.q) : null;
      const rows = await getDb()
        .select({ skill: skills, variables: skillVersions.variables })
        .from(skills)
        .innerJoin(
          skillVersions,
          and(eq(skillVersions.skillId, skills.id), eq(skillVersions.version, skills.latestVersion)),
        )
        .where(
          and(
            visibleTo(actor),
            query.archived === 'true'
              ? // The archived skills I may restore: mine, and an admin's team ones.
                and(
                  isNotNull(skills.archivedAt),
                  actor.role === 'admin'
                    ? or(eq(skills.ownerId, actor.id), eq(skills.space, 'team'))
                    : eq(skills.ownerId, actor.id),
                )
              : isNull(skills.archivedAt),
            query.space ? eq(skills.space, query.space) : undefined,
            query.kind ? eq(skills.kind, query.kind) : undefined,
            query.scan_status ? eq(skills.scanStatus, query.scan_status) : undefined,
            q
              ? or(
                  ilike(skills.name, q),
                  ilike(skills.displayName, q),
                  ilike(skills.description, q),
                  sql`${skills.tags}::text ilike ${q}`,
                )
              : undefined,
            before ? lt(skills.id, before) : undefined,
          ),
        )
        .orderBy(desc(skills.id))
        .limit(query.limit + 1);
      const ctx = await runContext(actor.id, await deps.agents.loadForTurn(actor.id, query.agent ?? 'main'));
      return toPage(
        rows.map((row) => ({ id: row.skill.id, ...row })),
        query.limit,
        (row) => toSkill(row.skill, actor, row.variables, unavailableFor(row.skill, ctx)),
      );
    },

    async get(actor: SkillActor, id: string): Promise<SkillDetail> {
      return mainDetail(actor, await visibleRow(actor, id));
    },

    async create(actor: SkillActor, input: CreateInput): Promise<SkillDetail> {
      if (input.kind === 'template') return mainDetail(actor, await createTemplate(actor, input));
      const upload = await uploadedZip(actor.id, input.file_id);
      const row = await createPackage(actor, input, readZip(upload.bytes));
      // The upload is replaced by the canonical copy the version holds.
      await deps.files.discard(upload.row.id);
      return mainDetail(actor, row);
    },

    async update(actor: SkillActor, id: string, input: UpdateSkillInput): Promise<SkillView> {
      const row = await manageableRow(actor, id);
      checkText('The display name', input.display_name);
      checkText('The description', input.description);
      checkTags(input.tags);
      const [updated] = await getDb()
        .update(skills)
        .set({
          ...(input.display_name !== undefined ? { displayName: input.display_name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          // An official skill keeps its mark.
          ...(input.tags !== undefined
            ? { tags: row.tags.includes(OFFICIAL_TAG) ? [OFFICIAL_TAG, ...input.tags] : input.tags }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(skills.id, row.id))
        .returning();
      return mainView(actor, updated!);
    },

    async archive(actor: SkillActor, id: string): Promise<void> {
      const row = await manageableRow(actor, id);
      if (row.archivedAt) return;
      await getDb()
        .update(skills)
        .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(skills.id, row.id));
    },

    async restore(actor: SkillActor, id: string): Promise<SkillDetail> {
      const row = await manageableRow(actor, id);
      const [restored] = await getDb()
        .update(skills)
        .set({ archivedAt: null, updatedAt: sql`now()` })
        .where(eq(skills.id, row.id))
        .returning();
      return mainDetail(actor, restored!);
    },

    async versions(actor: SkillActor, id: string): Promise<SkillVersionView[]> {
      const row = await visibleRow(actor, id);
      const rows = await getDb()
        .select()
        .from(skillVersions)
        .where(eq(skillVersions.skillId, row.id))
        .orderBy(desc(skillVersions.createdAt), desc(skillVersions.id));
      return rows.map(toVersion);
    },

    async addVersion(actor: SkillActor, id: string, input: VersionInput): Promise<SkillDetail> {
      const row = await manageableRow(actor, id);
      if (row.kind === 'package') {
        if (!input.file_id) throw invalidInput('Upload the new ZIP and give its file_id.');
        if (input.body !== undefined || input.variables !== undefined || input.requirements !== undefined) {
          throw invalidInput('A package changes with its ZIP: put the change in SKILL.md.');
        }
        const upload = await uploadedZip(actor.id, input.file_id);
        const updated = await appendVersion(actor, row, input, readZip(upload.bytes));
        await deps.files.discard(upload.row.id);
        return mainDetail(actor, updated);
      }
      return mainDetail(actor, await appendVersion(actor, row, input, null));
    },

    /**
     * Rescan: anyone who may change the skill; the verdict replaces the last one, but a skill
     * confirmed malicious stays blocked. Safe or malicious: its reviewer.
     */
    async scan(actor: SkillActor, id: string, input: ScanDecision): Promise<SkillView> {
      const row = await visibleRow(actor, id);
      let updated: SkillRow;
      if (input.decision === 'rescan') {
        if (!canManage(actor, row) && !canReview(actor, row)) throw forbidden('You cannot have this skill scanned.');
        const report = await rescanReport(actor.id, row);
        const [saved] = await getDb()
          .update(skills)
          .set({
            ...(row.scanStatus === 'blocked'
              ? { scanFindings: report.findings, scannedAt: new Date().toISOString() }
              : verdict(report, row.tags.includes(OFFICIAL_TAG) && row.scanNote === OFFICIAL_NOTE)),
            updatedAt: sql`now()`,
          })
          .where(and(eq(skills.id, row.id), eq(skills.latestVersion, row.latestVersion)))
          .returning();
        if (!saved) throw conflict('skill_changed', 'A version was added meanwhile; reload and try again.');
        updated = saved;
        await askForReview(updated, actor.id);
      } else {
        if (!canReview(actor, row)) {
          throw forbidden(
            row.space === 'team' ? 'An admin reviews team skills.' : 'Only its owner reviews a personal skill.',
          );
        }
        updated = await transaction(async (db) => {
          const [saved] = await db
            .update(skills)
            .set({
              scanStatus: input.decision === 'safe' ? 'clean' : 'blocked',
              scanReviewedBy: actor.id,
              scanNote: input.note ?? null,
              updatedAt: sql`now()`,
            })
            .where(eq(skills.id, row.id))
            .returning();
          if (row.space === 'team') {
            await audit({
              actorId: actor.id,
              action: input.decision === 'safe' ? 'skill.mark_safe' : 'skill.block',
              resourceType: 'skill',
              resourceId: row.id,
              summary: input.note ? 'note' : '',
            });
          }
          return saved!;
        });
        if (updated.ownerId !== actor.id) {
          const [owner] = await getDb()
            .select({ locale: members.locale })
            .from(members)
            .where(eq(members.id, updated.ownerId));
          const title = updated.displayName || updated.name;
          const en = owner?.locale === 'en';
          await deps.notifications.publish({
            memberId: updated.ownerId,
            kind: 'skill_scan',
            title:
              input.decision === 'safe'
                ? en
                  ? `An admin marked the skill "${title}" safe`
                  : han`管理员已将技能「${title}」标记为安全`
                : en
                  ? `An admin confirmed the skill "${title}" malicious`
                  : han`管理员已确认技能「${title}」为恶意`,
            targetType: 'skill',
            targetId: updated.id,
            payload: { category: 'skill_scan', status: updated.scanStatus },
            dedupeKey: `skill_review:${updated.id}:${updated.latestVersion}:${input.decision}`,
          });
        }
      }
      return mainView(actor, updated);
    },

    /** A signed URL to a package's ZIP. What waits for review or is blocked goes to its reviewers and owner only. */
    async download(actor: SkillActor, id: string, version?: string): Promise<SkillDownload> {
      const row = await visibleRow(actor, id);
      if (row.kind !== 'package') throw conflict('not_a_package', 'A template has no package to download.');
      if (row.scanStatus === 'blocked' && !canReview(actor, row)) {
        throw forbidden('This skill was confirmed malicious; only its reviewers can download it.');
      }
      const found = await versionOf(row.id, version ?? row.latestVersion);
      if (!found.bundleFileId) throw conflict('not_a_package', 'This version has no package.');
      const link = deps.files.signedUrl(found.bundleFileId, actor.id);
      await getDb()
        .update(skills)
        .set({ downloadCount: sql`${skills.downloadCount} + 1` })
        .where(eq(skills.id, row.id));
      return {
        name: packageFilename(row.name, found.version),
        version: found.version,
        sha256: found.sha256,
        size_bytes: found.sizeBytes,
        url: link.url,
        expires_at: link.expiresAt,
      };
    },

    /** My three most-used skills that can run for this Agent; else its template's opening lines. */
    async starters(actor: SkillActor, agent = 'main'): Promise<SkillStarters> {
      const loaded = await deps.agents.loadForTurn(actor.id, agent);
      const used = await getDb()
        .select({ id: sql<string>`${messages.skill}->>'skillId'`, uses: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(eq(messages.authorMemberId, actor.id), isNotNull(messages.skill)))
        .groupBy(sql`${messages.skill}->>'skillId'`)
        .orderBy(desc(sql`count(*)`), desc(sql`max(${messages.createdAt})`))
        .limit(20);
      const picked: SkillView[] = [];
      if (used.length) {
        const ctx = await runContext(actor.id, loaded);
        const rows = await getDb()
          .select({ skill: skills, variables: skillVersions.variables })
          .from(skills)
          .innerJoin(
            skillVersions,
            and(eq(skillVersions.skillId, skills.id), eq(skillVersions.version, skills.latestVersion)),
          )
          .where(and(visibleTo(actor), or(...used.map((entry) => eq(skills.id, entry.id)))));
        for (const entry of used) {
          const row = rows.find((candidate) => candidate.skill.id === entry.id);
          if (!row || unavailableFor(row.skill, ctx)) continue;
          picked.push(toSkill(row.skill, actor, row.variables, null));
          if (picked.length === 3) break;
        }
      }
      if (picked.length) return { skills: picked, starters: [] };
      const [member] = await getDb().select({ locale: members.locale }).from(members).where(eq(members.id, actor.id));
      const template = loaded.agent.isMain ? MAIN_AGENT_TEMPLATE : agentTemplate(loaded.agent.templateKey);
      return { skills: [], starters: template?.copy[member?.locale === 'en' ? 'en' : 'zh'].starters.slice(0, 3) ?? [] };
    },

    /**
     * Checks a `/` run before the message is sent: a skill the member sees, clean and not
     * archived, whose requirements every answering Agent meets, with its fields filled in.
     * Returns what the message records: the skill, the version that runs, the values.
     */
    async prepareRun(
      memberId: string,
      input: { skill_id: string; variables: Record<string, string> },
      agentIds: readonly string[],
    ): Promise<{ skillId: string; version: string; variables: Record<string, string> }> {
      const actor = await actorOf(memberId);
      const row = await visibleRow(actor, input.skill_id);
      const fixed = blockedReason(row);
      if (fixed) throw new ApiError(409, 'skill_unavailable', fixed.message, { code: fixed.code });
      for (const agentId of agentIds) {
        const loaded = await deps.agents.loadForTurn(memberId, agentId);
        const why = unavailableFor(row, await runContext(memberId, loaded));
        if (why) {
          throw new ApiError(409, 'skill_unavailable', why.message, {
            code: why.code,
            ...(why.connector ? { connector: why.connector } : {}),
          });
        }
      }
      const version = await versionOf(row.id, row.latestVersion);
      if (row.kind === 'package') return { skillId: row.id, version: version.version, variables: {} };
      const values = checkValues(version.variables, input.variables);
      if (!values.ok) throw invalidInput(values.message, { fields: values.fields });
      return { skillId: row.id, version: version.version, variables: values.values };
    },

    /**
     * Skills being equipped must be ones the owner sees and that can run for this Agent; one
     * that cannot is refused with why. Skills it already had are left alone.
     */
    async assertEquippable(memberId: string, manifest: AgentManifest, added: readonly string[]): Promise<void> {
      if (!added.length) return;
      const actor = await actorOf(memberId);
      const ctx = await runContext(memberId, { manifest, public: null });
      for (const id of added) {
        const [row] = await getDb()
          .select()
          .from(skills)
          .where(and(eq(skills.id, id), visibleTo(actor)));
        if (!row) throw new ApiError(400, 'invalid_input', `There is no skill ${id} you can use.`);
        const why = unavailableFor(row, ctx);
        if (why) {
          throw new ApiError(409, 'skill_unavailable', `${row.name} cannot be equipped: ${why.message}`, {
            skill_id: row.id,
            code: why.code,
            ...(why.connector ? { connector: why.connector } : {}),
          });
        }
      }
    },

    // ─── for the skill tools ──────────────────────────────

    /** An Agent's equipped skills the member sees, with why one cannot run here. */
    async equipped(
      memberId: string,
      manifest: AgentManifest,
      opts: { computer: boolean; publicAgent: boolean },
    ): Promise<AgentSkill[]> {
      if (!manifest.skills.length) return [];
      const actor = await actorOf(memberId);
      const rows = await getDb()
        .select()
        .from(skills)
        .where(and(or(...manifest.skills.map((id) => eq(skills.id, id))), visibleTo(actor)));
      const ctx = await contextFor(memberId, manifest, opts);
      return manifest.skills
        .map((id) => rows.find((row) => row.id === id))
        .filter((row): row is SkillRow => !!row)
        .map((row) => agentSkill(row, unavailableFor(row, ctx)));
    },

    /** Skills the member sees, matching the words, for an Agent: what can run first. */
    async search(memberId: string, query: string, agent: SkillAgent): Promise<AgentSkill[]> {
      const actor = await actorOf(memberId);
      const q = query.trim() ? containing(query.trim()) : null;
      const rows = await getDb()
        .select()
        .from(skills)
        .where(
          and(
            visibleTo(actor),
            isNull(skills.archivedAt),
            q ? or(ilike(skills.name, q), ilike(skills.displayName, q), ilike(skills.description, q)) : undefined,
          ),
        )
        .orderBy(desc(skills.id))
        .limit(40);
      const ctx = await runContext(memberId, agent);
      return rows
        .map((row) => agentSkill(row, unavailableFor(row, ctx)))
        .sort((a, b) => Number(!!a.unavailable) - Number(!!b.unavailable))
        .slice(0, 20);
    },

    /** A skill's instructions for an Agent that can run it: a template's text and fields, or SKILL.md and its files. */
    async load(memberId: string, ref: string, agent: SkillAgent) {
      const actor = await actorOf(memberId);
      const row = await byReference(actor, ref);
      if (!row) throw new Error(`There is no skill "${ref}" in the member's library.`);
      const why = unavailableFor(row, await runContext(memberId, agent));
      if (why) throw new Error(why.message);
      const version = await versionOf(row.id, row.latestVersion);
      return {
        name: row.name,
        version: version.version,
        kind: row.kind,
        description: row.description,
        instructions: version.body,
        ...(row.kind === 'template'
          ? {
              fields: version.variables,
              note: 'Fill the {{placeholders}} from the conversation; ask only for what you cannot tell.',
            }
          : { files: version.files.filter((file) => file.path !== 'SKILL.md').map((file) => file.path) }),
      };
    },

    /** One file of a package the member sees and may run, as text. */
    async readFile(memberId: string, ref: string, path: string) {
      const actor = await actorOf(memberId);
      const row = await byReference(actor, ref);
      if (!row) throw new Error(`There is no skill "${ref}" in the member's library.`);
      const why = blockedReason(row);
      if (why) throw new Error(why.message);
      if (row.kind !== 'package') throw new Error(`${row.name} is a template: load it to read its text.`);
      const version = await versionOf(row.id, row.latestVersion);
      const clean = path.replace(/^\.?\/+/, '');
      if (!version.files.some((file) => file.path === clean)) {
        throw new Error(
          `${row.name} has no file "${clean}". Its files: ${version.files.map((file) => file.path).join(', ')}.`,
        );
      }
      const file = (await packageFiles(memberId, version)).find((entry) => entry.path === clean)!;
      const text = textOf(file.bytes);
      if (text === null)
        return { skill: row.name, path: clean, note: `This is a binary file (${file.bytes.byteLength} bytes).` };
      const cut = text.length > READ_FILE_MAX_CHARS;
      return {
        skill: row.name,
        path: clean,
        content: cut ? text.slice(0, READ_FILE_MAX_CHARS) : text,
        ...(cut ? { truncated: true } : {}),
      };
    },

    /** Copies a package's files to the Agent's computer, into ~/skills/<name>/. */
    async install(memberId: string, agentId: string, ref: string) {
      const actor = await actorOf(memberId);
      const row = await byReference(actor, ref);
      if (!row) throw new Error(`There is no skill "${ref}" in the member's library.`);
      const why = blockedReason(row);
      if (why) throw new Error(why.message);
      if (row.kind !== 'package') throw new Error(`${row.name} is a template: it has no files to install.`);
      const version = await versionOf(row.id, row.latestVersion);
      const files = await packageFiles(memberId, version);
      const path = await installOnComputer(deps.computers, {
        memberId,
        agentId,
        name: row.name,
        zip: packageZip(row.name, files),
      });
      return { skill: row.name, version: version.version, path, files: files.map((file) => file.path) };
    },

    /** What `skill_mutation` proposed, saved as a template once the member accepts the card. */
    async saveTemplate(memberId: string, proposal: TemplateProposal): Promise<SkillView> {
      const actor = await actorOf(memberId);
      return mainView(actor, await createTemplate(actor, proposal));
    },

    // ─── official skills ──────────────────────────────────

    /**
     * Publishes skillhub/<group>/<name>/ as team skills at boot, owned by the first admin.
     * Idempotent: a pack whose content hash matches the latest version is skipped; a changed
     * pack needs a higher SKILL.md version and a CHANGELOG.md entry. Repository content is
     * reviewed with the code, so it is scanned and recorded but never held. Never throws.
     */
    async seedOfficial(dir: string = SKILLHUB_DIR) {
      const summary = { published: [] as string[], skipped: [] as string[], errors: [] as string[] };
      try {
        const packs = collectPacks(dir);
        if (!packs.length) return summary;
        const [owner] = await getDb()
          .select({ id: members.id, role: members.role })
          .from(members)
          .where(and(eq(members.role, 'admin'), eq(members.status, 'active')))
          .orderBy(members.createdAt, members.id)
          .limit(1);
        if (!owner) {
          logger.warn('[skills] no active admin yet: the official skills are published on a later start');
          return summary;
        }
        for (const pack of packs) {
          try {
            const files = readPackFiles(pack.dir);
            const pkg = readPackage(files);
            if (pkg.name !== pack.name) throw new Error(`SKILL.md says "${pkg.name}"; the folder is "${pack.name}"`);
            if (!pkg.version) throw new Error('SKILL.md needs a version');
            const changelogFile = files.find((file) => file.path === 'CHANGELOG.md');
            const changelog = changelogFile ? changelogEntry(textOf(changelogFile.bytes) ?? '', pkg.version) : null;
            if (!changelog) throw new Error(`CHANGELOG.md has no entry for ${pkg.version}`);
            const [existing] = await getDb()
              .select()
              .from(skills)
              .where(and(eq(skills.space, 'team'), eq(skills.name, pkg.name)));
            if (!existing) {
              await createPackage(owner, { space: 'team', version: pkg.version, changelog }, pkg, {
                official: true,
                tags: [OFFICIAL_TAG, pack.group],
              });
              summary.published.push(`${pkg.name}@${pkg.version}`);
              continue;
            }
            if (!existing.tags.includes(OFFICIAL_TAG)) throw new Error("a member's team skill already has this name");
            const latest = await versionOf(existing.id, existing.latestVersion);
            if (latest.sha256 === pkg.sha256) {
              summary.skipped.push(pkg.name);
              continue;
            }
            if (compareSemver(pkg.version, existing.latestVersion) <= 0) {
              throw new Error(`the content changed but ${pkg.version} is not above ${existing.latestVersion}`);
            }
            await appendVersion(owner, existing, { changelog, version: pkg.version }, pkg, { official: true });
            summary.published.push(`${pkg.name}@${pkg.version}`);
          } catch (error) {
            summary.errors.push(`${pack.name}: ${toErrorMessage(error)}`);
          }
        }
        if (summary.published.length || summary.errors.length) {
          logger.info('[skills] official skills', summary);
        }
      } catch (error) {
        logger.error('[skills] the official skills could not be published', { error: toErrorMessage(error) });
      }
      return summary;
    },
  };

  function agentSkill(row: SkillRow, unavailable: SkillUnavailable | null): AgentSkill {
    return {
      id: row.id,
      name: row.name,
      displayName: row.displayName || row.name,
      description: row.description.slice(0, BRIEF_MAX),
      kind: row.kind,
      unavailable,
    };
  }

  return service;
}

export type SkillsService = ReturnType<typeof createSkillsService>;
