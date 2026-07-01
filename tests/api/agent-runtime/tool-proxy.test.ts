/**
 * Tests for the cloud tool proxy core — the read-only allowlist intersection
 * and default-deny execution that form the proxy's security boundary.
 */

import { describe, it, expect } from 'vitest';
import {
  READONLY_PROXY_ALLOWLIST,
  MUTATING_PROXY_ALLOWLIST,
  resolveProxyToolIds,
  buildProxyManifest,
  executeProxyTool,
  assertWorkspaceAllowed,
  ProxyToolError,
} from '../../../apps/api/src/agent-runtime/tool-proxy.js';

describe('resolveProxyToolIds', () => {
  it('keeps only allowlisted tools from the effective set', () => {
    const effective = ['knowledge_query', 'knowledge_mutation', 'feature_request', 'analyze_image', 'project_query'];
    // knowledge_mutation is mutating but not opted-in → excluded;
    // feature_request is not in any proxy allowlist → excluded
    expect(resolveProxyToolIds(effective).sort()).toEqual(['analyze_image', 'knowledge_query', 'project_query']);
  });

  it('further narrows by the key-scoped read allowlist when present', () => {
    const effective = ['knowledge_query', 'analyze_image', 'compute'];
    const result = resolveProxyToolIds(effective, { allowedTools: ['analyze_image', 'compute', 'knowledge_mutation'] });
    expect(result.sort()).toEqual(['analyze_image', 'compute']);
  });

  it('treats an empty key allowlist as "no extra read narrowing"', () => {
    const effective = ['knowledge_query', 'analyze_image'];
    expect(resolveProxyToolIds(effective, { allowedTools: [] }).sort()).toEqual(['analyze_image', 'knowledge_query']);
  });

  it('writes are default-deny; only included when opted into allowedWriteTools', () => {
    const effective = ['analyze_image', 'knowledge_mutation', 'project_mutation'];
    // no write scope → writes excluded
    expect(resolveProxyToolIds(effective)).toEqual(['analyze_image']);
    // opted in → included
    expect(resolveProxyToolIds(effective, { allowedWriteTools: ['knowledge_mutation', 'project_mutation'] }).sort()).toEqual([
      'analyze_image',
      'knowledge_mutation',
      'project_mutation',
    ]);
  });

  it('includes first-class mutation tools only in the mutating allowlist', () => {
    const mutating = ['knowledge_mutation', 'project_mutation', 'email_mutation'];
    for (const id of mutating) {
      expect(MUTATING_PROXY_ALLOWLIST.has(id)).toBe(true);
      expect(READONLY_PROXY_ALLOWLIST.has(id)).toBe(false);
    }
    expect(resolveProxyToolIds(mutating, { allowedWriteTools: mutating }).sort()).toEqual(mutating.sort());
  });

  it('includes new first-class query tools as read-only tools', () => {
    const effective = ['project_query', 'session_query', 'knowledge_query'];
    expect(resolveProxyToolIds(effective).sort()).toEqual([...effective].sort());
    for (const id of effective) expect(READONLY_PROXY_ALLOWLIST.has(id)).toBe(true);
  });

  it('never includes non-allowlisted tools even if effective', () => {
    const other = ['email_manager', 'feature_request', 'generate_image'];
    expect(resolveProxyToolIds(other, { allowedWriteTools: other })).toEqual([]);
    for (const id of other) {
      expect(READONLY_PROXY_ALLOWLIST.has(id)).toBe(false);
      expect(MUTATING_PROXY_ALLOWLIST.has(id)).toBe(false);
    }
  });
});

describe('assertWorkspaceAllowed', () => {
  it('is a no-op when the key has no workspace allowlist', () => {
    expect(() => assertWorkspaceAllowed([], 'ws_1')).not.toThrow();
    expect(() => assertWorkspaceAllowed([], null)).not.toThrow();
  });

  it('allows a requested workspace that is in the allowlist', () => {
    expect(() => assertWorkspaceAllowed(['ws_1', 'ws_2'], 'ws_2')).not.toThrow();
  });

  it('rejects a requested workspace not in the allowlist (403)', () => {
    try {
      assertWorkspaceAllowed(['ws_1'], 'ws_9');
      throw new Error('expected assertWorkspaceAllowed to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProxyToolError);
      expect((err as ProxyToolError).status).toBe(403);
    }
  });

  it('passes when no workspace is requested even if the key is scoped', () => {
    // No workspace-bound tool is reachable through the read-only proxy yet.
    expect(() => assertWorkspaceAllowed(['ws_1'], null)).not.toThrow();
    expect(() => assertWorkspaceAllowed(['ws_1'], undefined)).not.toThrow();
  });
});

describe('buildProxyManifest', () => {
  it('maps tool IDs to registry metadata and skips unknown IDs', () => {
    const manifest = buildProxyManifest(['knowledge_query', 'not_a_real_tool']);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({ id: 'knowledge_query', category: 'team', mutating: false });
    expect(typeof manifest[0].description).toBe('string');
    expect(manifest[0].description.length).toBeGreaterThan(0);
  });

  it('flags mutating tools in the manifest', () => {
    const manifest = buildProxyManifest(['knowledge_mutation', 'project_mutation']);
    expect(manifest[0]).toMatchObject({ id: 'knowledge_mutation', mutating: true });
    expect(manifest[1]).toMatchObject({ id: 'project_mutation', mutating: true });
  });
});

describe('executeProxyTool', () => {
  // Hand-rolled tool mirroring the AI SDK `tool()` shape the proxy duck-types:
  // a `safeParse`-bearing inputSchema + an `execute` function.
  const echo = {
    inputSchema: {
      safeParse: (v: unknown) => {
        const obj = v as { q?: unknown };
        return typeof obj?.q === 'string'
          ? { success: true, data: obj }
          : { success: false, error: { issues: [{ path: ['q'], message: 'expected string' }] } };
      },
    },
    execute: async (input: { q: string }) => ({ echoed: input.q }),
  };
  const registry = { knowledge_query: echo } as Record<string, unknown>;

  it('rejects a tool that is not in the allowed set (403)', async () => {
    await expect(executeProxyTool(registry, 'knowledge_query', [], { q: 'hi' })).rejects.toMatchObject({
      name: 'ProxyToolError',
      status: 403,
    });
  });

  it('returns 404 when the tool has no implementation', async () => {
    await expect(
      executeProxyTool({}, 'knowledge_query', ['knowledge_query'], { q: 'hi' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('validates input against the tool schema (400 on bad input)', async () => {
    await expect(
      executeProxyTool(registry, 'knowledge_query', ['knowledge_query'], { q: 123 }),
    ).rejects.toBeInstanceOf(ProxyToolError);
  });

  it('executes an allowed tool with valid input', async () => {
    const out = await executeProxyTool(registry, 'knowledge_query', ['knowledge_query'], { q: 'nutrient' });
    expect(out).toEqual({ echoed: 'nutrient' });
  });

  it('maps legacy read endpoint IDs to the combined tool when the new tool is allowed', async () => {
    const out = await executeProxyTool(registry, 'search_team_knowledge', ['knowledge_query'], { q: 'nutrient' });
    expect(out).toEqual({ echoed: 'nutrient' });
  });

  it('requires confirm:true for a mutating tool (400 without it)', async () => {
    const writeTool = {
      inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
      execute: async () => ({ ok: true }),
    };
    const reg = { knowledge_mutation: writeTool } as Record<string, unknown>;
    const allowed = ['knowledge_mutation'];

    // no confirm → 400
    await expect(executeProxyTool(reg, 'knowledge_mutation', allowed, {})).rejects.toMatchObject({ status: 400 });
    // confirm:true → executes
    const out = await executeProxyTool(reg, 'knowledge_mutation', allowed, {}, { confirm: true });
    expect(out).toEqual({ ok: true });
  });
});
