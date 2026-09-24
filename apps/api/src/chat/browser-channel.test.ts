/**
 * The browser-extension conversation's inline tool face, checked against the
 * REAL catalog: a writer added to the catalog tomorrow must not reach a
 * conversation that reads untrusted web pages.
 */

import { describe, expect, it } from 'vitest';
import { filterBrowserSessionToolIds } from './browser-channel.js';
import { getAllToolIds, getToolMeta, MUTATING_PROXY_ALLOWLIST } from '../tools/registry.js';
import { DISPATCH_TOOL_IDS } from '../agent-runtime/tool-resolution.js';

const OUTPUT_ONLY = ['ask_user', 'export_data'];

describe('browser-channel tool face', () => {
  const kept = filterBrowserSessionToolIds(getAllToolIds());

  it('drops every proxy-confirmed writer', () => {
    expect(MUTATING_PROXY_ALLOWLIST.size).toBeGreaterThan(0);
    for (const id of MUTATING_PROXY_ALLOWLIST) expect(kept, id).not.toContain(id);
  });

  it('drops the writers the proxy never sees, and the drafts the panel cannot confirm', () => {
    const offPanel = ['memory', 'workbench_mutation', 'feature_request', 'log_friction', 'spawn_session', 'call_llm'];
    for (const id of [...offPanel, ...DISPATCH_TOOL_IDS]) expect(kept, id).not.toContain(id);
  });

  it('keeps the reads and the output-only tools a browsing conversation needs', () => {
    expect(kept).toEqual(
      expect.arrayContaining(['knowledge_query', 'project_query', 'session_query', 'external_search', ...OUTPUT_ONLY]),
    );
  });

  it('is fail-closed: all it keeps is a declared proxy read or an explicit output-only tool', () => {
    for (const id of kept) {
      expect(getToolMeta(id)?.surface?.proxy === 'read' || OUTPUT_ONLY.includes(id), id).toBe(true);
    }
    expect(filterBrowserSessionToolIds(['not_in_the_catalog'])).toEqual([]);
  });
});
