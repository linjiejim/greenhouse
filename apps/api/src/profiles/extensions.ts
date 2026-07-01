/**
 * Fork extension point for system profiles — the ONLY file a downstream fork
 * edits to add private first-party agent profiles (e.g. eval-judge, desktop).
 *
 * Upstream ships this EMPTY. `profile.ts` splices EXTENSION_SYSTEM_PROFILES into
 * the SYSTEM_PROFILES map, so a fork profile is loadable/listable/resolvable
 * WITHOUT editing profile.ts. A fork profile's `tools` are validated against the
 * live tool catalog, which already includes fork tools registered via
 * tools/extensions.ts — so a private profile may reference private tools.
 *
 * Fork example (in the fork's copy of this file):
 *   import evalJudge from './eval-judge.js';   // defineProfile({...})
 *   import desktop from './desktop.js';
 *   export const EXTENSION_SYSTEM_PROFILES: AgentProfile[] = [evalJudge, desktop];
 */

import type { AgentProfile } from '../profile.js';

/** Private system profiles contributed by a downstream fork. Empty upstream. */
export const EXTENSION_SYSTEM_PROFILES: AgentProfile[] = [];
