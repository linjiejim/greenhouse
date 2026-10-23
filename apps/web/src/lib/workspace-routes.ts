/**
 * Canonical hashes of the personal workspace tabs, and the redirects that keep
 * the pages they replaced reachable.
 *
 * 1.5 folded the standalone My Prompts page (`#/tasks`) into SkillHub and the
 * My Agents page (`#/agents`) into Automations. Old bookmarks, chat links and
 * the legacy `#/chat?view=…` switches land on the tabs.
 */

/** SkillHub → My prompts. */
export const SKILLHUB_PROMPTS_HASH = '#/skillhub?tab=prompts';

/** SkillHub → Report templates (v1.7). */
export const SKILLHUB_REPORTS_HASH = '#/skillhub?tab=reports';

/** Automations → Run profiles (custom agents). */
export const AUTOMATIONS_PROFILES_HASH = '#/automations?tab=profiles';

/**
 * Where a retired workspace hash goes now, or null when `topLevel` is not one.
 * `view` is the `?view=` of a legacy `#/chat?view=…` link.
 */
export function retiredWorkspaceRedirect(topLevel: string, view?: string | null): string | null {
  if (topLevel === 'tasks' || topLevel === 'prompts') return SKILLHUB_PROMPTS_HASH;
  if (topLevel === 'agents') return AUTOMATIONS_PROFILES_HASH;
  if (topLevel !== 'chat') return null;
  // Chat utilities used to be in-memory workspace switches.
  if (view === 'prompts') return SKILLHUB_PROMPTS_HASH;
  if (view === 'automations') return '#/automations';
  if (view === 'agents') return AUTOMATIONS_PROFILES_HASH;
  return null;
}
