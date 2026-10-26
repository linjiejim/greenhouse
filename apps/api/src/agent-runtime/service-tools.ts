/**
 * The paid services members' agents reach from outside Greenhouse (v1.6) —
 * built only on the external surfaces, `/api/mcp` and `/api/agent`.
 *
 * Chat has its own faces of the same implementations: external_search (search
 * and page extraction in one call) and generate_image rendered inline. An
 * external agent gets web_search and read_url as separate tools, and its
 * generated images land on the member's personal Files shelf, where the agent
 * can find them again. Every call is metered under the scope the route set
 * (MCP: client `mcp` + the OAuth client id).
 *
 * Laid over buildLazyServerTools' registry, so `generate_image` here replaces
 * the Chat build.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import type { ToolRegistry } from '../agent.js';
import { createGenerateImageTool } from '../tools/generate-image.js';
import { createReadUrlTool, createWebSearchTool } from '../tools/web-search.js';
import { fromExtensions } from '../extensions/index.js';

export function buildExternalServiceTools(
  db: DatabaseProvider,
  effectiveTools: readonly string[],
  ctx: { userId: string },
): ToolRegistry {
  const tools: ToolRegistry = {};
  if (effectiveTools.includes('web_search')) tools.web_search = createWebSearchTool();
  if (effectiveTools.includes('read_url')) tools.read_url = createReadUrlTool();
  if (effectiveTools.includes('generate_image')) {
    tools.generate_image = createGenerateImageTool({ db, userId: ctx.userId, saveTo: 'files' });
  }
  for (const mod of fromExtensions('tools')) {
    if (!mod.meta.surface?.externalOnly || !mod.createLazy || !effectiveTools.includes(mod.meta.id)) continue;
    tools[mod.meta.id] = mod.createLazy({ db, userId: ctx.userId, userRole: 'team' }) as ToolRegistry[string];
  }
  return tools;
}

/**
 * Why an external tool cannot run at all right now — today only the cloud
 * computer while its workspace switch is off — or null. Asked per request,
 * never cached.
 */
export async function externalToolUnavailableMessage(toolId: string): Promise<string | null> {
  for (const check of fromExtensions('toolAvailability')) {
    const reason = await check(toolId);
    if (reason) return reason;
  }
  return null;
}

/** The tools a listing shows: a computer tool is not listed at all while the switch is off. */
export async function listableExternalToolIds(toolIds: readonly string[]): Promise<string[]> {
  const unavailable = await Promise.all(toolIds.map((id) => externalToolUnavailableMessage(id)));
  return toolIds.filter((_, index) => unavailable[index] === null);
}
