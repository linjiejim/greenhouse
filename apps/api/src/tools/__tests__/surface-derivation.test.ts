/**
 * GUARD TEST — pins the proxy/MCP exposure surface.
 *
 * The READONLY_PROXY_ALLOWLIST / MUTATING_PROXY_ALLOWLIST / MCP_EXPOSED_TOOL_IDS
 * sets are DERIVED from each tool's declarative `meta.surface` field (see
 * tools/define.ts + registry.ts). This is a security-relevant surface: anything in
 * these sets is reachable by trusted runtimes (Local Agent / CLI) over /api/agent
 * and by external agents over /api/mcp.
 *
 * This test hardcodes the EXACT expected sets and asserts the derivation reproduces
 * them. Any future change to a tool's `surface` (or a new tool that accidentally
 * declares one) shifts these sets and fails CI here — forcing a conscious review of
 * the exposure invariant. If you intentionally change the surface, update BOTH the
 * tool's `meta.surface` and the expected arrays below in the same change.
 */

import { describe, it, expect } from 'vitest';
import { READONLY_PROXY_ALLOWLIST, MUTATING_PROXY_ALLOWLIST, MCP_EXPOSED_TOOL_IDS } from '../registry.js';

// The frozen invariant. Order-independent — compared as sorted arrays / sets.
const EXPECTED_READONLY = [
  'team_knowledge',
  'external_search',
  'compute',
  'analyze_image',
  'session_history',
  'project_query',
  'session_query',
  'knowledge_query',
  'email_query',
];

const EXPECTED_MUTATING = ['project_mutation', 'knowledge_mutation', 'email_mutation'];

const EXPECTED_MCP = [
  'knowledge_query',
  'knowledge_mutation',
  'team_knowledge',
  'project_query',
  'project_mutation',
  'email_query',
  'email_mutation',
  'session_query',
  'session_history',
];

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe('proxy/MCP surface derivation (security invariant)', () => {
  it('READONLY_PROXY_ALLOWLIST exactly equals the frozen read set', () => {
    expect(sorted(READONLY_PROXY_ALLOWLIST)).toEqual(sorted(EXPECTED_READONLY));
  });

  it('MUTATING_PROXY_ALLOWLIST exactly equals the frozen write set', () => {
    expect(sorted(MUTATING_PROXY_ALLOWLIST)).toEqual(sorted(EXPECTED_MUTATING));
  });

  it('MCP_EXPOSED_TOOL_IDS exactly equals the frozen MCP set', () => {
    expect(sorted(MCP_EXPOSED_TOOL_IDS)).toEqual(sorted(EXPECTED_MCP));
  });

  it('every MCP-exposed tool is also in a proxy allowlist (mcp:true never grants access alone)', () => {
    const proxied = new Set([...READONLY_PROXY_ALLOWLIST, ...MUTATING_PROXY_ALLOWLIST]);
    for (const id of MCP_EXPOSED_TOOL_IDS) {
      expect(proxied.has(id), `MCP tool "${id}" is not in any proxy allowlist`).toBe(true);
    }
  });

  it('read and write proxy sets are disjoint', () => {
    for (const id of READONLY_PROXY_ALLOWLIST) {
      expect(MUTATING_PROXY_ALLOWLIST.has(id), `"${id}" is in both read and write sets`).toBe(false);
    }
  });
});
