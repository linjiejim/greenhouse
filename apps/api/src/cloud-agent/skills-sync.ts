/**
 * Skill Center → sandbox skills sync.
 *
 * Materializes every ACTIVE Skill Center skill (latest version) into
 * `<dataRoot>/shared/skills/<name>/…`, which the controller mounts read-only
 * at /home/agent/.agents/skills — the directory convention Pi discovers
 * natively. Idempotent via a per-skill `.version` marker; skills that
 * disappear from the center are removed on the next sync. When the operator
 * pins CLOUD_AGENT_SKILLS_DIR the sync is bypassed entirely (ops-managed
 * directory).
 *
 * Bundle paths are already whitelist-validated at publish time
 * (skills/bundle.ts: segment charset, no `..`), so joining them under the
 * target dir is safe.
 */

import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '@greenhouse/utils/logger';
import type { DatabaseProvider } from '@greenhouse/db';
import { downloadSkill } from '../skills/center.js';
import { isMissionReadySkill } from '../skills/mission-ready.js';

const SYNC_TTL_MS = 5 * 60_000;
const VERSION_MARKER = '.version';

let lastSyncAt = 0;
let lastResult: string | null = null;
let syncing: Promise<string | null> | null = null;

export function skillsDirFor(dataRoot: string): string {
  return join(dataRoot, 'shared', 'skills');
}

async function markerVersion(dir: string): Promise<string | null> {
  try {
    return (await readFile(join(dir, VERSION_MARKER), 'utf8')).trim();
  } catch {
    return null;
  }
}

async function syncOnce(db: DatabaseProvider, dataRoot: string): Promise<string | null> {
  const target = skillsDirFor(dataRoot);
  await mkdir(target, { recursive: true });

  // Quarantined skills are excluded here too. This is NOT the security boundary
  // — downloadSkill refuses them regardless — it keeps the 5-minute sync from
  // logging a wall of warnings, and it makes an ALREADY-materialized copy
  // disappear on the next pass once its skill turns suspicious: anything not in
  // `wanted` is removed below. That is how a skill quarantined after it reached
  // the sandbox gets cleaned up.
  //
  // Unattended sandboxes receive only repository-managed first-party content or
  // clean third-party content that a super explicitly reviewed.
  //
  // Page through the WHOLE catalog: db.skills.list defaults to 50 rows, and
  // anything not in `wanted` is REMOVED below — a truncated read would delete
  // materialized skills 51+ and strand any mission that names one.
  const all = [];
  const PAGE = 100;
  for (let offset = 0; ; offset += PAGE) {
    const page = await db.skills.list({ status: 'active', limit: PAGE, offset });
    all.push(...page);
    if (page.length < PAGE) break;
  }
  const skills = all.filter(isMissionReadySkill);
  const wanted = new Set(skills.map((s) => s.name));

  // Drop skills that left the center (archived/deleted/quarantined).
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.isDirectory() && !wanted.has(entry.name)) {
      await rm(join(target, entry.name), { recursive: true, force: true });
    }
  }

  let synced = 0;
  for (const skill of skills) {
    const dir = join(target, skill.name);
    if ((await markerVersion(dir)) === skill.latest_version) continue;
    const result = await downloadSkill(db, skill.name, undefined, { meter: false });
    if (!result.ok) {
      logger.warn('[cloud-agent] skill sync skipped', { skill: skill.name, error: result.error });
      continue;
    }
    await rm(dir, { recursive: true, force: true });
    for (const file of result.files) {
      const full = join(dir, file.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content);
    }
    await writeFile(join(dir, VERSION_MARKER), skill.latest_version, 'utf8');
    synced += 1;
  }
  if (synced > 0) logger.info('[cloud-agent] skills synced', { synced, total: skills.length });
  return skills.length > 0 ? target : null;
}

/**
 * TTL-throttled sync; concurrent callers share one pass. Failures fall back
 * to the last good directory — a sync hiccup must not block run starts.
 *
 * `force` skips the TTL (still sharing an in-flight pass): a skill-launch
 * enqueue names a specific skill the user just saw in the catalog, and a
 * skill published or reviewed within the TTL would otherwise be admitted
 * while its directory is missing or stale in the sandbox mount.
 */
export async function ensureSkillsSynced(
  db: DatabaseProvider,
  dataRoot: string,
  opts?: { force?: boolean },
): Promise<string | null> {
  if (syncing) return syncing;
  if (!opts?.force && Date.now() - lastSyncAt < SYNC_TTL_MS) return lastResult;
  syncing = syncOnce(db, dataRoot)
    .then((dir) => {
      lastSyncAt = Date.now();
      lastResult = dir;
      return dir;
    })
    .catch((err) => {
      logger.error('[cloud-agent] skills sync failed', { err: String(err) });
      lastSyncAt = Date.now(); // don't hot-loop a broken store
      return lastResult;
    })
    .finally(() => {
      syncing = null;
    });
  return syncing;
}

/** Test seam. */
export function _resetSkillsSync(): void {
  lastSyncAt = 0;
  lastResult = null;
  syncing = null;
}
