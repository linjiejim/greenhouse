/**
 * The MCP OAuth consent rules (app/oauth-consent.web.tsx), React-free (./consent.test.ts), the
 * classic consent page's rules unchanged:
 *
 * - `mcp:read` / `mcp:write` say which verbs; they are shown, not chosen.
 * - Resource groups say which data. Offered: the ones the request names that this station has
 *   (the core groups but retired ones, then the groups of the plugins the member sees); all start
 *   ticked. Groups it names that the station does not offer are never granted.
 * - Approving grants the action scopes plus the ticked groups, never more than was asked; with no
 *   group ticked there is nothing to approve (the server refuses it too).
 * - The station's answer must return to the request's own address with the request's own state;
 *   anything else is not followed.
 */

import { MCP_RESOURCE_GROUP_IDS, RETIRED_MCP_RESOURCE_GROUP_IDS } from '../shared/greenhouse-types';
import type { LocalizedText } from '../shared/plugins';

export type CoreGroup = Exclude<(typeof MCP_RESOURCE_GROUP_IDS)[number], 'image'>;

export const CORE_GROUPS = MCP_RESOURCE_GROUP_IDS.filter(
  (id): id is CoreGroup => !RETIRED_MCP_RESOURCE_GROUP_IDS.includes(id),
);

export type ConsentGroup =
  | { id: string; scope: string; core: CoreGroup }
  | { id: string; scope: string; plugin: { name: LocalizedText; description: LocalizedText | null } };

/** The plugins of the station manifest, as far as consent reads them. */
export interface GroupOwner {
  name: LocalizedText;
  description: LocalizedText | null;
  mcp_groups: string[];
  nav?: { label: LocalizedText }[];
}

export function actionScopes(scopes: readonly string[]): ('mcp:read' | 'mcp:write')[] {
  return (['mcp:read', 'mcp:write'] as const).filter((scope) => scopes.includes(scope));
}

export function offeredGroups(scopes: readonly string[], plugins: readonly GroupOwner[]): ConsentGroup[] {
  const asked = (id: string) => scopes.includes(`mcp:${id}`);
  const core: ConsentGroup[] = CORE_GROUPS.filter(asked).map((id) => ({ id, scope: `mcp:${id}`, core: id }));
  const seen = new Set<string>(core.map((group) => group.id));
  const owned: ConsentGroup[] = [];
  for (const plugin of plugins)
    for (const id of plugin.mcp_groups)
      if (asked(id) && !seen.has(id) && !RETIRED_MCP_RESOURCE_GROUP_IDS.includes(id)) {
        seen.add(id);
        // the name the member knows the app by (its rail entry), else the plugin's own
        owned.push({
          id,
          scope: `mcp:${id}`,
          plugin: { name: plugin.nav?.[0]?.label ?? plugin.name, description: plugin.description },
        });
      }
  return [...core, ...owned];
}

/** What an approval grants: the action scopes the request named plus the ticked offered groups. */
export function grantedScopes(scopes: readonly string[], offered: readonly ConsentGroup[], ticked: ReadonlySet<string>) {
  return [...actionScopes(scopes), ...offered.filter((group) => ticked.has(group.scope)).map((group) => group.scope)];
}

/** The address an approval or a refusal returns to, as a person reads it (its host, or its scheme). */
export function redirectHost(uri: string): string {
  try {
    const url = new URL(uri);
    return url.host || `${url.protocol}//`;
  } catch {
    return uri;
  }
}

/** The station's answer goes back to the request's own address and carries the request's state. */
export function followsRequest(redirectTo: string, request: { redirect_uri: string; state: string }): boolean {
  try {
    const target = new URL(redirectTo);
    const own = new URL(request.redirect_uri);
    return (
      target.protocol === own.protocol &&
      target.host === own.host &&
      target.pathname === own.pathname &&
      target.searchParams.get('state') === request.state
    );
  } catch {
    return false;
  }
}
