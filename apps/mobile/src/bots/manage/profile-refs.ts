/**
 * Which stored agent ids are this Bot — for the lists its profile gathers
 * (automations; the conversation list asks the server, `?profile=`). Pure: the
 * root vitest pins it.
 *
 * A stored `profile_id` names its Bot as `bot:<id>`, a pinned version
 * `bot:<id>@<v>`; the member's main Bot is `sprouty` — and every retired id the
 * server folds into it (apps/api/src/profiles/profile.ts
 * `LEGACY_TEAM_PROFILE_IDS`, mirrored here: rows keep them).
 */

const SPROUTY_IDS = [
  'sprouty',
  'sprouty-quick',
  'sprouty-deep',
  'sprouty-k3',
  'sprouty-workflows',
  'workflow-planner',
  'sprouty-agents',
  'sprouty-mission',
  'team',
  'default',
  'researcher',
  'writer',
  'project-assistant',
  'cs-quality',
  'ops-analyst',
  'cc-analyzer',
  'crm',
];

/** Every stored spelling of this Bot (exact, or followed by `@<version>`). */
export function profileRefs(bot: { id: string; main: boolean }): string[] {
  return bot.main ? [...SPROUTY_IDS, `bot:${bot.id}`] : [`bot:${bot.id}`];
}

export function matchesProfile(profileId: string, refs: readonly string[]): boolean {
  return refs.some((ref) => profileId === ref || profileId.startsWith(`${ref}@`));
}

/** What `GET /api/sessions?profile=` takes for this Bot. */
export function profileQuery(bot: { id: string; main: boolean }): string {
  return bot.main ? 'sprouty' : `bot:${bot.id}`;
}
