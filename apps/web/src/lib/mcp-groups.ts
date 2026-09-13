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

import type { McpResourceGroup } from '@greenhouse/types/mcp';
import type { TranslationKey } from './i18n';

export function mcpGroupLabelKey(id: McpResourceGroup): TranslationKey {
  return `mcpGroups.${id}.label` as TranslationKey;
}

export function mcpGroupDescriptionKey(id: McpResourceGroup): TranslationKey {
  return `mcpGroups.${id}.description` as TranslationKey;
}
