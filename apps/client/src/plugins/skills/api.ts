/**
 * SkillHub calls (`/api/skills`, plugins/skills/api/routes.ts): the catalog, one skill with its
 * whole version history, and publishing a skill or a new version of one. Versions are immutable;
 * an update needs a changelog; the station scans every bundle before it stores it.
 */

import { get, post, seg } from '../../api/client';
import type { BundleFile } from './bundle';

export interface SkillSummary {
  name: string;
  display_name: string;
  description: string;
  tags: string[];
  latest_version: string;
  status: 'active' | 'archived';
  owner_user_id: string;
  download_count: number;
  scan_status: 'pending' | 'clean' | 'suspicious' | 'blocked';
  source_group: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillVersion {
  version: string;
  changelog: string;
  file_count: number;
  size_bytes: number;
  content_hash: string;
  created_by: string;
  created_at: string;
}

export const listSkills = () => get<{ total: number; skills: SkillSummary[] }>('/api/skills', { limit: 100 });

export const getSkill = (name: string) =>
  get<{ skill: SkillSummary; versions: SkillVersion[] }>(`/api/skills/${seg(name)}`);

export interface PublishInput {
  name: string;
  display_name?: string;
  description?: string;
  tags?: string[];
  version?: string;
  changelog?: string;
  files: BundleFile[];
}

export const publishSkill = (input: PublishInput) =>
  post<{ created: boolean; skill: SkillSummary; version: SkillVersion }>('/api/skills/publish', input);
