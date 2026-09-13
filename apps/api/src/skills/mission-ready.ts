/**
 * Which Skill Center skills a Cloud Agent mission can actually use.
 *
 * Sandbox readiness and direct slash launch are related but distinct facts.
 * `mission_ready` decides what may be mounted into an unattended sandbox.
 * `slash_selectable` is narrower: only first-party packs in the repository's
 * branding/business groups may be selected and launched directly from Chat.
 * The catalog and POST /runs share the latter predicate so stale UI state or a
 * hand-written request cannot bypass the picker policy.
 *
 * Unattended sandboxes receive only repository-managed first-party content or
 * clean third-party content a super explicitly reviewed (scan spec D4).
 */

import { firstPartySkillGroup, isFirstPartySkill } from './first-party.js';

/** The columns the verdict reads — both SkillRow and SkillSummary satisfy it. */
export interface MissionReadySkillFields {
  name: string;
  status: 'active' | 'archived';
  scan_status: string;
  scan_reviewed_by: string | null;
}

export function isMissionReadySkill(skill: MissionReadySkillFields): boolean {
  return (
    skill.status === 'active' &&
    skill.scan_status === 'clean' &&
    (isFirstPartySkill(skill.name) || skill.scan_reviewed_by !== null)
  );
}

const SLASH_SELECTABLE_GROUPS = new Set(['branding', 'business']);

export function isSlashSelectableSkill(skill: MissionReadySkillFields): boolean {
  const group = firstPartySkillGroup(skill.name);
  return isMissionReadySkill(skill) && group !== null && SLASH_SELECTABLE_GROUPS.has(group);
}
