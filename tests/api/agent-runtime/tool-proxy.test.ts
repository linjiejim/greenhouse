import { getAllToolIds } from '../../../apps/api/src/tools/registry.js';
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
    const effective = ['session_query', 'automation_mutation', 'tables_schema_plan', 'analyze_image', 'files_query'];
    // automation_mutation is mutating but not opted-in → excluded; tables_schema_plan has no surface
    expect(resolveProxyToolIds(effective).sort()).toEqual(['analyze_image', 'files_query', 'session_query']);
  });

  it('further narrows by the key-scoped read allowlist when present', () => {
    const effective = ['session_query', 'analyze_image', 'compute'];
    const result = resolveProxyToolIds(effective, {
      allowedTools: ['analyze_image', 'compute', 'automation_mutation'],
    });
    expect(result.sort()).toEqual(['analyze_image', 'compute']);
  });

  it('treats an omitted read allowlist as "no extra read narrowing"', () => {
    const effective = ['session_query', 'analyze_image'];
    expect(resolveProxyToolIds(effective, {}).sort()).toEqual(['analyze_image', 'session_query']);
    expect(resolveProxyToolIds(effective, { allowedTools: undefined }).sort()).toEqual([
      'analyze_image',
      'session_query',
    ]);
  });

  it('treats an EMPTY read allowlist as zero readable tools, not as "everything"', () => {
    // MCP derives this list from the granted resource groups. Reading empty as
    // "no narrowing" would turn the narrowest possible grant into full access —
    // the exact inversion this assertion exists to prevent.
    const effective = ['session_query', 'analyze_image'];
    expect(resolveProxyToolIds(effective, { allowedTools: [] })).toEqual([]);
  });

  it('writes are default-deny; only included when opted into allowedWriteTools', () => {
    const effective = ['analyze_image', 'automation_mutation', 'files_mutation'];
    // no write scope → writes excluded
    expect(resolveProxyToolIds(effective)).toEqual(['analyze_image']);
    // opted in → included
    expect(
      resolveProxyToolIds(effective, { allowedWriteTools: ['automation_mutation', 'files_mutation'] }).sort(),
    ).toEqual(['analyze_image', 'automation_mutation', 'files_mutation']);
  });

  it('includes first-class mutation tools only in the mutating allowlist', () => {
    const mutating = ['tables_mutation', 'files_mutation', 'automation_mutation'].filter((id) =>
      getAllToolIds().includes(id),
    );
    for (const id of mutating) {
      expect(MUTATING_PROXY_ALLOWLIST.has(id)).toBe(true);
      expect(READONLY_PROXY_ALLOWLIST.has(id)).toBe(false);
    }
    expect(resolveProxyToolIds(mutating, { allowedWriteTools: mutating }).sort()).toEqual(mutating.sort());
  });

  it('includes new first-class query tools as read-only tools', () => {
    const effective = ['tables_query', 'files_query', 'session_query', 'session_query'].filter((id) =>
      getAllToolIds().includes(id),
    );
    expect(resolveProxyToolIds(effective).sort()).toEqual([...effective].sort());
    for (const id of effective) expect(READONLY_PROXY_ALLOWLIST.has(id)).toBe(true);
  });

  it('never includes non-allowlisted tools even if effective', () => {
    const other = ['tables_schema_plan', 'memory'];
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

  it('requires the caller to select a workspace when the credential is scoped', () => {
    for (const workspaceId of [null, undefined]) {
      try {
        assertWorkspaceAllowed(['ws_1'], workspaceId);
        throw new Error('expected assertWorkspaceAllowed to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ProxyToolError);
        expect((err as ProxyToolError).status).toBe(403);
      }
    }
  });
});

describe('buildProxyManifest', () => {
  it('maps tool IDs to registry metadata and skips unknown IDs', () => {
    const manifest = buildProxyManifest(['session_query', 'not_a_real_tool']);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({ id: 'session_query', category: 'team', mutating: false });
    expect(typeof manifest[0].description).toBe('string');
    expect(manifest[0].description.length).toBeGreaterThan(0);
  });

  it('flags mutating tools in the manifest', () => {
    const manifest = buildProxyManifest(['automation_mutation', 'files_mutation']);
    expect(manifest[0]).toMatchObject({ id: 'automation_mutation', mutating: true });
    expect(manifest[1]).toMatchObject({ id: 'files_mutation', mutating: true });
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
  const registry = { session_query: echo } as Record<string, unknown>;

  it('rejects a tool that is not in the allowed set (403)', async () => {
    await expect(executeProxyTool(registry, 'session_query', [], { q: 'hi' })).rejects.toMatchObject({
      name: 'ProxyToolError',
      status: 403,
    });
  });

  it('returns 404 when the tool has no implementation', async () => {
    await expect(executeProxyTool({}, 'session_query', ['session_query'], { q: 'hi' })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('validates input against the tool schema (400 on bad input)', async () => {
    await expect(executeProxyTool(registry, 'session_query', ['session_query'], { q: 123 })).rejects.toBeInstanceOf(
      ProxyToolError,
    );
  });

  it('executes an allowed tool with valid input', async () => {
    const out = await executeProxyTool(registry, 'session_query', ['session_query'], { q: 'nutrient' });
    expect(out).toEqual({ echoed: 'nutrient' });
  });

  it('refuses a retired tool name even when its successor is allowed', async () => {
    await expect(
      executeProxyTool(registry, 'session_history', ['session_query'], { q: 'nutrient' }),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it('requires confirm:true for a mutating tool (400 without it)', async () => {
    const writeTool = {
      inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
      execute: async () => ({ ok: true }),
    };
    const reg = { automation_mutation: writeTool } as Record<string, unknown>;
    const allowed = ['automation_mutation'];

    // no confirm → 400
    await expect(executeProxyTool(reg, 'automation_mutation', allowed, {})).rejects.toMatchObject({ status: 400 });
    // confirm:true → executes
    const out = await executeProxyTool(reg, 'automation_mutation', allowed, {}, { confirm: true });
    expect(out).toEqual({ ok: true });
  });
});
