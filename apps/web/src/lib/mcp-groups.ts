/**
 * MCP resource-group display copy.
 *
 * The group registry (`@greenhouse/types/mcp`) carries identity only, so the labels
 * a user reads when authorizing an MCP client live in the locale files under
 * `mcpGroups.<id>`. These keys are DATA-DRIVEN — derived from the id rather than
 * written at a `t()` call site — so the `TranslationKey` union cannot check
 * them; `lib/i18n/localized.test.ts` asserts every group resolves in both
 * locales (same guard the email presets get, and for the same reason: a
 * renamed namespace otherwise ships the raw key string to the screen).
 */

import { MCP_RESOURCE_GROUP_IDS } from '@greenhouse/types/mcp';
import type { TranslationKey } from './i18n';
import { registeredMcpGroups } from './extension-registries';

export function mcpGroupLabelKey(id: string): TranslationKey {
  const registered = registeredMcpGroups().find((group) => group.id === id);
  return (registered ? registered.labelKey : `mcpGroups.${id}.label`) as TranslationKey;
}

export function mcpGroupDescriptionKey(id: string): TranslationKey {
  const registered = registeredMcpGroups().find((group) => group.id === id);
  return (registered ? registered.descriptionKey : `mcpGroups.${id}.description`) as TranslationKey;
}

/**
 * Groups to offer in the consent screen and the machine-client form: the core
 * ones plus those of the extensions this deployment actually runs.
 */
export function mcpGroupIds(activeExtensionIds: readonly string[]): string[] {
  const active = new Set(activeExtensionIds);
  return [
    ...MCP_RESOURCE_GROUP_IDS,
    ...registeredMcpGroups()
      .filter((group) => active.has(group.extensionId))
      .map((group) => group.id),
  ];
}
