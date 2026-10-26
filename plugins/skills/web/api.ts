/**
 * Skill Center API client — the enterprise skill hub (/api/skills).
 *
 * The declared return interfaces mirror this plugin's api/skills/center.ts.
 * Requests use the host's authenticated transport at the unchanged URLs.
 */

import { authFetch, qs } from '@greenhouse/web/extension-kit';
import { downloadAuthenticatedFile } from '@greenhouse/web/extension-kit';

export type SkillScanStatus = 'pending' | 'clean' | 'suspicious' | 'blocked';
/** Mirrors the API's FIRST_PARTY_SKILL_GROUPS — `core`/`apps` retired 2026-08-17. */
export type SkillSourceGroup = 'branding' | 'business';

export interface SkillScanFinding {
  rule: string;
  severity: 'high' | 'medium';
  path?: string;
  excerpt: string;
}

export interface SkillSummary {
  name: string;
  display_name: string;
  description: string;
  tags: string[];
  latest_version: string;
  status: 'active' | 'archived';
  owner_user_id: string;
  download_count: number;
  scan_status: SkillScanStatus;
  scan_findings: SkillScanFinding[];
  scan_version: string | null;
  scanned_at: string | null;
  scan_reviewed_by: string | null;
  scan_reviewed_at: string | null;
  scan_note: string | null;
  /** Trusted first-party repository group; null for user/team skills. */
  source_group: SkillSourceGroup | null;
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

export interface SkillFileEntry {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

function errorOf(data: unknown, fallback: string): string {
  return data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
    ? (data as { error: string }).error
    : fallback;
}

export async function listSkills(opts: {
  q?: string;
  status?: 'active' | 'archived' | 'all';
  limit?: number;
  offset?: number;
}): Promise<{ total: number; skills: SkillSummary[] }> {
  const query: Record<string, string> = {};
  if (opts.q) query.q = opts.q;
  if (opts.status) query.status = opts.status;
  if (opts.limit !== undefined) query.limit = String(opts.limit);
  if (opts.offset !== undefined) query.offset = String(opts.offset);
  const res = await authFetch('/api/skills' + qs(query));
  if (!res.ok) throw new Error('Failed to load skills');
  return res.json();
}

export async function getSkill(name: string): Promise<{ skill: SkillSummary; versions: SkillVersionSummary[] }> {
  const res = await authFetch(`/api/skills/${encodeURIComponent(name)}`);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || 'error' in data) throw new Error(errorOf(data, 'Failed to load skill'));
  return data;
}

export async function downloadSkillBundle(
  name: string,
  version?: string,
  opts?: { meter?: boolean },
): Promise<{ skill: SkillSummary; version: SkillVersionSummary; files: SkillFileEntry[] }> {
  // meter:false = passive browse (render SKILL.md / preview files) — don't inflate download_count.
  const query: Record<string, string> = {};
  if (version) query.version = version;
  if (opts?.meter === false) query.meter = 'false';
  const res = await authFetch(`/api/skills/${encodeURIComponent(name)}/download` + qs(query));
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || 'error' in data) throw new Error(errorOf(data, 'Failed to download skill'));
  return data;
}

/** Explicit user download: the complete installable Skill package, not its JSON wire representation. */
export async function downloadSkillArchive(name: string, version: string): Promise<void> {
  const url = `/api/skills/${encodeURIComponent(name)}/download.zip?version=${encodeURIComponent(version)}`;
  return downloadAuthenticatedFile(url, `${name}-${version}.zip`);
}

export interface PublishSkillInput {
  name: string;
  display_name?: string;
  description?: string;
  tags?: string[];
  version?: string;
  changelog?: string;
  files: SkillFileEntry[];
}

export async function publishSkill(
  input: PublishSkillInput,
): Promise<{ created: boolean; skill: SkillSummary; version: SkillVersionSummary }> {
  // No validator on this route — pass json indirectly per the hc convention.
  const res = await authFetch('/api/skills/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || 'error' in data) throw new Error(errorOf(data, 'Failed to publish skill'));
  return data;
}

/** Super only — rule on a scanner verdict. `blocked` is the permanent ban. */
export async function decideSkillScan(
  name: string,
  decision: 'clean' | 'blocked',
  note?: string,
): Promise<SkillSummary> {
  const res = await authFetch(`/api/skills/${encodeURIComponent(name)}/scan-decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, note }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || 'error' in data) throw new Error(errorOf(data, 'Failed to record the decision'));
  return data.skill;
}

/** Super only — re-run the scanner over the latest version. */
export async function rescanSkill(name: string): Promise<SkillSummary> {
  const res = await authFetch(`/api/skills/${encodeURIComponent(name)}/rescan`, { method: 'POST' });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || 'error' in data) throw new Error(errorOf(data, 'Failed to rescan skill'));
  return data.skill;
}

export async function archiveSkill(name: string): Promise<SkillSummary> {
  const res = await authFetch(`/api/skills/${encodeURIComponent(name)}/archive`, { method: 'POST' });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || 'error' in data) throw new Error(errorOf(data, 'Failed to archive skill'));
  return data.skill;
}

export async function unarchiveSkill(name: string): Promise<SkillSummary> {
  const res = await authFetch(`/api/skills/${encodeURIComponent(name)}/unarchive`, { method: 'POST' });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || 'error' in data) throw new Error(errorOf(data, 'Failed to unarchive skill'));
  return data.skill;
}

export async function deleteSkill(name: string): Promise<void> {
  const res = await authFetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(errorOf(data, 'Failed to delete skill'));
  }
}
