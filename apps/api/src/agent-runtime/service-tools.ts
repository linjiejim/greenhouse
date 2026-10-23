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
  return tools;
}
