/**
 * skillhub boot-seed — publish the repo's first-party skill packs into the
 * Skill Center at server startup, so skills ship with the release instead of
 * via a manual sync (docs/specs/20260722-skillhub-first-party-skills.md).
 *
 * Idempotent and never fatal: per-pack content hashes are compared against the
 * center (same canonical algorithm as bundle.ts); unchanged packs are skipped,
 * bumped packs are published, changed-but-not-bumped packs are logged as
 * errors WITHOUT blocking boot. Deployments without a skillhub/ directory
 * (e.g. the standalone prod image) skip seeding entirely.
 *
 * The filesystem/parsing layer mirrors scripts/skillhub-sync.mjs (the manual
 * CLI path); tests/skillhub/boot-seed-parity.test.ts pins the two against
 * each other so they cannot drift.
 */

import { extensionSkillPackDirs } from '../extensions/boot.js';
import { resolvePackPath } from '../config/greenhouse-config.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@greenhouse/utils/logger';
import { compareSemver, isValidSemver } from '@greenhouse/utils/semver';
import type { DatabaseProvider } from '@greenhouse/db';
import { bundleContentHash, validateBundleFiles, type SkillFile } from './bundle.js';
import { getSkillDetail, publishSkill, type Actor } from './center.js';

const TEXT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'svg',
  'html',
  'css',
  'js',
  'mjs',
  'cjs',
  'ts',
  'json',
  'yml',
  'yaml',
  'xml',
  'csv',
]);

// ─── Filesystem + parsing layer (mirror of skillhub-sync.mjs) ─────

export interface SkillPackRef {
  group: string;
  name: string;
  dir: string;
}

export interface LocalSkillPack extends SkillPackRef {
  files: SkillFile[];
  frontmatterName?: string;
  description?: string;
  displayName?: string;
  version: string;
  changelog?: string;
  hash: string;
}

export function parseFrontmatter(skillMd: string): { name?: string; description?: string; version?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!match) return {};
  const out: { name?: string; description?: string; version?: string } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^(name|description|version):\s*(.+)$/.exec(line.trim());
    if (kv) out[kv[1] as 'name' | 'description' | 'version'] = kv[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export function deriveDisplayName(skillMd: string): string | undefined {
  const body = skillMd.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading ? heading[1]!.trim() : undefined;
}

export function extractChangelog(changelogMd: string, version: string): string | undefined {
  const lines = changelogMd.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${version.replace(/\./g, '\\.')}(\\s|$)`).test(l.trim()));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l.trim()));
  const body = rest
    .slice(0, end < 0 ? rest.length : end)
    .join('\n')
    .trim();
  return body || undefined;
}

export function collectSkillDirs(root: string): SkillPackRef[] {
  const found: SkillPackRef[] = [];
  for (const group of readdirSync(root)) {
    const groupDir = join(root, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const name of readdirSync(groupDir)) {
      const dir = join(groupDir, name);
      if (!statSync(dir).isDirectory()) continue;
      if (existsSync(join(dir, 'SKILL.md'))) found.push({ group, name, dir });
    }
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function readBundleFiles(dir: string): SkillFile[] {
  const files: SkillFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry.startsWith('.')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const path = relative(dir, full).split('\\').join('/');
      const ext = entry.includes('.') ? entry.split('.').pop()!.toLowerCase() : '';
      if (TEXT_EXTENSIONS.has(ext)) files.push({ path, content: readFileSync(full, 'utf8') });
      else files.push({ path, content: readFileSync(full).toString('base64'), encoding: 'base64' });
    }
  };
  walk(dir);
  return files;
}

/** Read one pack off disk into publish-ready form (canonical files + hash). */
export function loadLocalSkill(ref: SkillPackRef): LocalSkillPack | { ref: SkillPackRef; error: string } {
  const validated = validateBundleFiles(readBundleFiles(ref.dir));
  if (!validated.ok) return { ref, error: validated.error };
  const files = validated.value.files;
  const skillMd = files.find((f) => f.path === 'SKILL.md')?.content ?? '';
  const frontmatter = parseFrontmatter(skillMd);
  const changelogMd = files.find((f) => f.path === 'CHANGELOG.md')?.content ?? '';
  const version = frontmatter.version ?? '';
  return {
    ...ref,
    files,
    frontmatterName: frontmatter.name,
    description: frontmatter.description,
    displayName: deriveDisplayName(skillMd),
    version,
    changelog: version ? extractChangelog(changelogMd, version) : undefined,
    hash: bundleContentHash(files),
  };
}

// ─── Seed orchestration ──────────────────────────────────

/**
 * Locate the repo's skillhub/ directory: env override first, then relative to
 * this module (apps/api/{src,dist}/skills → repo root — both are four levels
 * deep), then the process cwd. Null when absent (deploys without the repo).
 */
export function resolveSkillhubDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.SKILLHUB_DIR,
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../../skillhub'),
    resolve(process.cwd(), 'skillhub'),
  ].filter((c): c is string => Boolean(c));
  for (const dir of candidates) {
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  }
  return null;
}

/**
 * The publishing identity: SKILLHUB_SEED_OWNER_EMAIL when set (must resolve to
 * an active super admin), otherwise the earliest-created super admin.
 */
export async function resolveSeedOwner(
  db: DatabaseProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Actor | null> {
  const email = env.SKILLHUB_SEED_OWNER_EMAIL?.trim();
  if (email) {
    const user = await db.users.getByEmail(email);
    if (user && user.status === 'active' && user.role === 'super') return { userId: user.id, role: user.role };
    logger.warn(`[skillhub] SKILLHUB_SEED_OWNER_EMAIL "${email}" does not resolve to an active super — seed skipped`);
    return null;
  }
  const users = await db.users.list();
  const firstSuper = users.find((u) => u.role === 'super' && u.status === 'active');
  return firstSuper ? { userId: firstSuper.id, role: firstSuper.role } : null;
}

export interface SeedSummary {
  dir: string;
  published: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Sync every pack under skillhub/ into the Skill Center. Returns null when
 * there is nothing to do (no directory / no owner); never throws.
 */
export async function seedSkillhub(
  db: DatabaseProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedSummary | null> {
  try {
    const dir = resolveSkillhubDir(env);
    if (!dir) return null;
    const owner = await resolveSeedOwner(db, env);
    if (!owner) {
      logger.warn('[skillhub] no seed owner (no active super yet?) — skillhub seed skipped');
      return null;
    }

    const summary: SeedSummary = { dir, published: [], skipped: [], errors: [] };
    // skillhub/ first, then the pack roots from greenhouse.config.ts and the
    // ones bundled with active extensions — same layout, same rules.
    const roots = [dir, ...extensionSkillPackDirs().map((root) => resolvePackPath(root))].filter(
      (root, i, all) => existsSync(root) && all.indexOf(root) === i,
    );
    for (const ref of roots.flatMap((root) => collectSkillDirs(root))) {
      const local = loadLocalSkill(ref);
      if ('error' in local) {
        summary.errors.push(`${ref.name}: ${local.error}`);
        continue;
      }
      if (local.frontmatterName !== local.name) {
        summary.errors.push(`${local.name}: frontmatter name (${local.frontmatterName}) 与目录名不一致`);
        continue;
      }
      if (!isValidSemver(local.version)) {
        summary.errors.push(`${local.name}: frontmatter version 非法: ${local.version}`);
        continue;
      }
      if (!local.changelog) {
        summary.errors.push(`${local.name}: CHANGELOG.md 缺少 ${local.version} 条目`);
        continue;
      }

      const remote = await getSkillDetail(db, local.name);
      if (remote) {
        const latest = remote.versions.find((v) => v.version === remote.skill.latest_version);
        if (latest?.content_hash === local.hash) {
          summary.skipped.push(local.name);
          continue;
        }
        if (compareSemver(local.version, remote.skill.latest_version) <= 0) {
          summary.errors.push(
            `${local.name}: 内容已变但版本未递增（本地 ${local.version} ≤ 中心 ${remote.skill.latest_version}）`,
          );
          continue;
        }
      }

      const result = await publishSkill(db, owner, {
        name: local.name,
        version: local.version,
        changelog: local.changelog,
        description: local.description,
        display_name: local.displayName,
        tags: ['official', local.group],
        files: local.files,
        // Repo content ships with the release and was code-reviewed — scan it
        // for observability, never quarantine it (spec D3). A server that
        // refuses to boot because it flagged its own skill library is not an
        // acceptable failure mode.
      });
      if (result.ok) summary.published.push(`${local.name}@${local.version}`);
      else summary.errors.push(`${local.name}: ${result.error}`);
    }

    if (summary.published.length > 0 || summary.errors.length > 0) {
      logger.info(
        `[skillhub] seed: ${summary.published.length} published, ${summary.skipped.length} unchanged, ${summary.errors.length} errors`,
        { published: summary.published, errors: summary.errors },
      );
    }
    return summary;
  } catch (error) {
    logger.error(`[skillhub] seed failed (boot continues): ${String(error)}`);
    return null;
  }
}
