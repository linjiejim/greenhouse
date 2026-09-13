/**
 * Who counts as a first-party ("official") skill.
 *
 * Trust must NOT be read off the `official` tag: tags are owner-editable through
 * `publishSkill` and `updateSkillMeta`, so anyone who can publish could tag their
 * own bundle `official` and — before this module existed — have the scanner's
 * verdict forced to `clean` by the boot backfill. The repo's `skillhub/`
 * directory is the actual source of truth for first-party packs (see
 * docs/specs/20260722-skillhub-first-party-skills.md), and nothing a user can
 * send over HTTP changes what is on disk.
 *
 * Deployments without the repo checked out (`resolveSkillhubDir()` → null) get
 * an empty set, which is the fail-closed answer: every skill is then scanned as
 * untrusted rather than every skill being trusted.
 *
 * The listing is cached because it is read once per publish and the directory
 * only changes with a deployment. `resetFirstPartyCache()` exists for tests.
 */

import { collectSkillDirs, resolveSkillhubDir } from './boot-seed.js';
import { logger } from '@greenhouse/utils/logger';

/**
 * The repo's skill groups. `core` and `apps` were retired on 2026-08-17 (spec
 * 20260722 D13) — a skill that only restates a tool's own description drifts,
 * so anything with no playbook beyond the tool self-description no longer gets
 * a pack. Keeping the retired names listed here would be a `for future use`
 * value with zero consumers; re-adding a group is a deliberate act that should
 * show up as a type error rather than silently work.
 */
export const FIRST_PARTY_SKILL_GROUPS = ['branding', 'business'] as const;
export type FirstPartySkillGroup = (typeof FIRST_PARTY_SKILL_GROUPS)[number];

interface FirstPartyIndex {
  names: Set<string>;
  groups: Map<string, FirstPartySkillGroup>;
}

let cache: FirstPartyIndex | null = null;

function isFirstPartySkillGroup(value: string): value is FirstPartySkillGroup {
  return (FIRST_PARTY_SKILL_GROUPS as readonly string[]).includes(value);
}

function firstPartyIndex(): FirstPartyIndex {
  if (cache) return cache;
  const dir = resolveSkillhubDir();
  if (!dir) {
    logger.warn('[skills] no skillhub/ directory — treating every skill as third-party for scanning');
    cache = { names: new Set(), groups: new Map() };
    return cache;
  }
  try {
    const refs = collectSkillDirs(dir);
    cache = {
      names: new Set(refs.map((ref) => ref.name)),
      groups: new Map(
        refs
          .filter((ref) => isFirstPartySkillGroup(ref.group))
          .map((ref) => [ref.name, ref.group as FirstPartySkillGroup]),
      ),
    };
  } catch (error) {
    logger.warn(`[skills] could not list skillhub/ (${String(error)}) — treating every skill as third-party`);
    cache = { names: new Set(), groups: new Map() };
  }
  return cache;
}

/** Names of the skill packs the repo owns, read from `skillhub/<group>/<name>/`. */
export function firstPartySkillNames(): Set<string> {
  return firstPartyIndex().names;
}

/** True only for packs the repo ships; never inferred from user-supplied tags. */
export function isFirstPartySkill(name: string): boolean {
  return firstPartySkillNames().has(name);
}

/** Trusted repository group for a first-party pack; never inferred from tags. */
export function firstPartySkillGroup(name: string): FirstPartySkillGroup | null {
  return firstPartyIndex().groups.get(name) ?? null;
}

export function resetFirstPartyCache(): void {
  cache = null;
}

/** Tests only: pin the repo listing so a fixture can stand in for skillhub/. */
export function _setFirstPartyNamesForTests(names: Set<string>): void {
  cache = { names, groups: new Map() };
}

/** Tests only: pin both first-party membership and its repository group. */
export function _setFirstPartyGroupsForTests(groups: Map<string, FirstPartySkillGroup>): void {
  cache = { names: new Set(groups.keys()), groups };
}
