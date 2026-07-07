/**
 * Skill Center API client — the enterprise skill hub (/api/skills).
 *
 * The declared return interfaces mirror the server's wire shapes
 * (apps/api/src/skills/center.ts); hc's inferred response types are assigned
 * to them, so any server-side drift fails compilation here.
 */

import { rpc } from './client';

export interface SkillSummary {
  name: string;
  display_name: string;
  description: string;
  tags: string[];
  latest_version: string;
  status: 'active' | 'archived';
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
  const res = await rpc.api.skills.$get({ query });
  if (!res.ok) throw new Error('Failed to load skills');
  return res.json();
}

export async function getSkill(name: string): Promise<{ skill: SkillSummary; versions: SkillVersionSummary[] }> {
  const res = await rpc.api.skills[':name'].$get({ param: { name } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || 'error' in data) throw new Error(errorOf(data, 'Failed to load skill'));
  return data;
}

export async function downloadSkillBundle(
  name: string,
  version?: string,
): Promise<{ skill: SkillSummary; version: SkillVersionSummary; files: SkillFileEntry[] }> {
  const args = { param: { name }, query: version ? { version } : {} };
  const res = await rpc.api.skills[':name'].download.$get(args);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || 'error' in data) throw new Error(errorOf(data, 'Failed to download skill'));
  return data;
}

export async function archiveSkill(name: string): Promise<SkillSummary> {
  const res = await rpc.api.skills[':name'].archive.$post({ param: { name } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || 'error' in data) throw new Error(errorOf(data, 'Failed to archive skill'));
  return data.skill;
}

export async function unarchiveSkill(name: string): Promise<SkillSummary> {
  const res = await rpc.api.skills[':name'].unarchive.$post({ param: { name } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || 'error' in data) throw new Error(errorOf(data, 'Failed to unarchive skill'));
  return data.skill;
}

export async function deleteSkill(name: string): Promise<void> {
  const res = await rpc.api.skills[':name'].$delete({ param: { name } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(errorOf(data, 'Failed to delete skill'));
  }
}
