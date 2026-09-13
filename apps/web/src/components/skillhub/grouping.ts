/**
 * SkillHub grouping & search — pure functions (unit-tested in grouping.test.ts).
 *
 * First-party browsing groups come from `source_group`, which the server
 * derives from the repository path. User-editable tags remain searchable but
 * never decide a trusted group. Team/personal origin stays owner-derived.
 */

import type { SkillSourceGroup, SkillSummary } from '../../lib/api/skills';

export type SkillGroupKey = 'review' | SkillSourceGroup | 'team' | 'mine';
export type SkillOriginKey = 'builtin' | 'team' | 'mine';

export interface SkillGroup {
  key: SkillGroupKey;
  label: string;
  skills: SkillSummary[];
}

export const GROUP_LABELS: Record<SkillGroupKey, string> = {
  review: 'Needs review',
  branding: 'Branding',
  business: 'Business',
  team: 'Team',
  mine: 'Mine',
};

/** `review` first: a quarantined skill is a queue item, not a browsing category. */
const GROUP_ORDER: SkillGroupKey[] = ['review', 'branding', 'business', 'team', 'mine'];

/** The origin groups — everything except the review queue (used by the landing counters). */
export const ORIGIN_ORDER: SkillOriginKey[] = ['builtin', 'team', 'mine'];

/** Flagged by the security scanner and not yet cleared — downloads are refused. */
export function needsReview(skill: SkillSummary): boolean {
  return skill.scan_status === 'suspicious' || skill.scan_status === 'blocked';
}

export function classifySkill(skill: SkillSummary, currentUserId: string | undefined): SkillGroupKey {
  if (skill.source_group) return skill.source_group;
  if (currentUserId && skill.owner_user_id === currentUserId) return 'mine';
  return 'team';
}

export function classifySkillOrigin(skill: SkillSummary, currentUserId: string | undefined): SkillOriginKey {
  if (skill.source_group) return 'builtin';
  if (currentUserId && skill.owner_user_id === currentUserId) return 'mine';
  return 'team';
}

export function countSkillOrigins(
  skills: SkillSummary[],
  currentUserId: string | undefined,
): Record<SkillOriginKey, number> {
  const counts: Record<SkillOriginKey, number> = { builtin: 0, team: 0, mine: 0 };
  for (const skill of skills) counts[classifySkillOrigin(skill, currentUserId)] += 1;
  return counts;
}

/**
 * Bucket active skills into ordered non-empty groups. Archived skills are
 * handled separately by the caller.
 *
 * `canReview` (super) pulls quarantined skills out of their origin group into a
 * "Needs review" queue at the top. For everyone else they stay in place with a
 * status tag — hiding them would make a skill that is merely unusable look
 * deleted, and its owner still has to find it to fix it.
 */
export function groupSkills(
  skills: SkillSummary[],
  currentUserId: string | undefined,
  canReview = false,
): SkillGroup[] {
  const buckets: Record<SkillGroupKey, SkillSummary[]> = {
    review: [],
    branding: [],
    business: [],
    team: [],
    mine: [],
  };
  for (const s of skills) {
    if (canReview && needsReview(s)) buckets.review.push(s);
    else buckets[classifySkill(s, currentUserId)].push(s);
  }
  return GROUP_ORDER.map((key) => ({ key, label: GROUP_LABELS[key], skills: buckets[key] })).filter(
    (g) => g.skills.length > 0,
  );
}

/** How many active skills are awaiting a security ruling — derived client-side, no endpoint. */
export function countNeedsReview(skills: SkillSummary[] | null): number {
  return (skills ?? []).filter((s) => s.status === 'active' && needsReview(s)).length;
}

/** Case-insensitive contains match over display_name / name / description / tags. */
export function filterSkills(skills: SkillSummary[], query: string): SkillSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter(
    (s) =>
      s.display_name.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some((t) => t.toLowerCase().includes(q)),
  );
}
