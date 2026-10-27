/**
 * External-only tools (`surface.externalOnly`): built for members' agents on
 * /api/mcp and /api/agent, never for Chat — so no in-app catalog may offer
 * them: not the tool picker (GET /api/tools), not the permissions dialog's
 * buckets, not the Agent editor or per-user assignment.
 */

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DatabaseProvider } from '@greenhouse/db';

const held = vi.hoisted(() => ({ tools: [] as string[] }));
vi.mock('../../agent.js', () => ({
  resolveUserTools: async () => ({ allowedTools: held.tools, activeTools: held.tools }),
}));

import {
  EXTERNAL_ONLY_TOOL_IDS,
  MCP_EXPOSED_TOOL_IDS,
  MUTATING_PROXY_ALLOWLIST,
  READONLY_PROXY_ALLOWLIST,
  getAllToolIds,
  getInAppToolIds,
  getInAppToolMetas,
} from '../registry.js';
import { buildLazyServerTools } from '../../agent-runtime/tool-resolution.js';
import { buildExternalServiceTools } from '../../agent-runtime/service-tools.js';
import { toolsetToolIds } from '../../plugin-host/feature-points.js';
import toolsRoute from '../../routes/tools.js';
import type { AppEnv } from '../../app-env.js';

const EXTERNAL = [
  'web_search',
  'read_url',
  'computer_exec',
  'computer_files',
  'computer_transfer',
  'computer_stop',
].filter((id) => getAllToolIds().includes(id));

describe('external-only tools', () => {
  it('are exactly the MCP-only services and the cloud computer, each reachable from outside', () => {
    expect([...EXTERNAL_ONLY_TOOL_IDS].sort()).toEqual([...EXTERNAL].sort());
    for (const id of EXTERNAL_ONLY_TOOL_IDS) {
      expect(MCP_EXPOSED_TOOL_IDS.has(id), `${id} is not on MCP`).toBe(true);
      expect(READONLY_PROXY_ALLOWLIST.has(id) || MUTATING_PROXY_ALLOWLIST.has(id), `${id} has no proxy tier`).toBe(
        true,
      );
    }
  });

  it('are never built for Chat, only for the external surfaces', () => {
    const db = {} as DatabaseProvider;
    const chat = buildLazyServerTools(db, getAllToolIds(), { userId: 'u1', userRole: 'team' });
    for (const id of EXTERNAL) expect(Object.keys(chat)).not.toContain(id);
    const external = buildExternalServiceTools(db, getAllToolIds(), { userId: 'u1' });
    for (const id of EXTERNAL) expect(Object.keys(external)).toContain(id);
  });

  it('stay out of the in-app catalogs', () => {
    for (const id of EXTERNAL) {
      expect(getInAppToolIds()).not.toContain(id);
      expect(getInAppToolMetas().map((meta) => meta.id)).not.toContain(id);
      expect(toolsetToolIds()).not.toContain(id);
    }
    // Tools Chat does build stay listed, generate_image and analyze_image included.
    expect(getInAppToolIds()).toEqual(expect.arrayContaining(['generate_image', 'analyze_image', 'external_search']));
  });

  it('are not offered by the tool picker even to someone who holds them', async () => {
    held.tools = getAllToolIds();
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('user', { id: 'u1', role: 'super' } as never);
        await next();
      })
      .route('/', toolsRoute);
    const body = (await (await app.request('/')).json()) as { tools: Array<{ id: string }> };
    const ids = body.tools.map((tool) => tool.id);
    expect(ids).toContain('generate_image');
    for (const id of EXTERNAL) expect(ids).not.toContain(id);
  });
});
