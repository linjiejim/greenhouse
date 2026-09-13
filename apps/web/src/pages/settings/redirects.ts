/**
 * Legacy Settings deep-link redirects — pure resolver, unit-tested in
 * redirects.test.ts.
 *
 * Admin modules moved to the separate #/administration surface; these keep
 * historical `#/settings/<x>` links (bookmarks, pins) alive. Extracted from the
 * page component so the redirect map can be exercised without mounting React.
 */

/** Default settings module when the sub-path is empty. */
export const DEFAULT_MODULE = 'preferences';

/**
 * Old `#/settings/<key>` → administration module key. Keys map 1:1 to the admin
 * module of the same name, except `permissions`: the former standalone "App
 * Permissions" page folded into the per-user modal, so it lands on Users.
 *
 * Keep this in sync with `administrationModules` (nav-registry) — a redirect
 * whose target module no longer exists is the exact gap the test guards.
 */
export const ADMIN_REDIRECTS: Record<string, string> = {
  users: 'users',
  usage: 'usage',
  'feature-requests': 'feature-requests',
  frictions: 'frictions',
  eval: 'eval',
  'llm-gateway': 'llm-gateway',
  'mcp-keys': 'mcp-keys',
  'runtime-config': 'runtime-config',
  branding: 'branding',
  permissions: 'users',
};

/**
 * Resolve a legacy Settings sub-path to its new canonical hash, or `null` when
 * the path is a real Settings module that stays put.
 */
export function resolveSettingsRedirect(subPath: string): string | null {
  const segments = subPath.split('/').filter(Boolean);
  const moduleKey = segments[0] || DEFAULT_MODULE;

  // Custom agents moved out of Settings into their own surface (v3).
  if (moduleKey === 'my-profiles') return '#/agents';

  // The read-only System Agents inventory was retired once the product
  // converged on one built-in preset. Keep historical links useful by landing
  // on the remaining usage surface rather than falling back to Preferences.
  if (moduleKey === 'profiles') return '#/administration/usage';

  // Personal utilities are independent, refresh-safe pages now.
  if (moduleKey === 'automations') return '#/automations';
  if (moduleKey === 'prompts') return '#/tasks';

  const adminTarget = ADMIN_REDIRECTS[moduleKey];
  if (adminTarget) {
    // Preserve any sub-path only for 1:1 remaps (e.g. eval/runs/123); folded
    // pages like permissions→users have no sub-route of their own.
    const rest = adminTarget === moduleKey ? segments.slice(1) : [];
    return `#/administration/${[adminTarget, ...rest].join('/')}`;
  }

  return null;
}
