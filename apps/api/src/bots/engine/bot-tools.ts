/**
 * A Bot's tool filter applied to its owner's allowed set — a LEAF module (no
 * engine imports), shared by the interactive turn and background tasks.
 */

import type { BotRow } from '@greenhouse/db';
import { safeJsonParse } from '@greenhouse/utils/json';
import { BUILTIN_AGENT_TOOL_IDS } from '../../tools/registry.js';

/**
 * The member's allowed tools narrowed to this Bot's own filter (null = no
 * narrowing). The same rule a Chat session with the Bot applies
 * (resolveEffectiveTools): a Bot can only ever narrow its owner's set; the
 * built-ins ride along as they do there.
 */
export function botEffectiveTools(memberTools: readonly string[], bot: Pick<BotRow, 'tools'>): string[] {
  if (bot.tools == null) return [...memberTools];
  const allowed = new Set<string>([...(safeJsonParse(bot.tools, []) as string[]), ...BUILTIN_AGENT_TOOL_IDS]);
  return memberTools.filter((id) => allowed.has(id));
}
