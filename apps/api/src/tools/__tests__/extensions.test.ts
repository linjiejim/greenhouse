/**
 * GUARD TEST — the tool-catalog fork extension point (tools/extensions.ts).
 *
 * The open-source release must ship ZERO private tools: EXTENSION_TOOL_MODULES is
 * the seam a downstream fork populates, and it must stay empty upstream. If a fork
 * tool ever leaks into this repo, this fails CI. It also documents the contract:
 * everything derived from the catalog (allowlists, global/public ids) composes
 * core + extensions, so a fork gets full exposure by editing only extensions.ts.
 */

import { describe, it, expect } from 'vitest';
import { EXTENSION_TOOL_MODULES } from '../extensions.js';
import { getAllToolIds } from '../registry.js';

describe('tool-catalog extension seam', () => {
  it('ships no private tools upstream (OSS invariant)', () => {
    expect(Array.isArray(EXTENSION_TOOL_MODULES)).toBe(true);
    expect(EXTENSION_TOOL_MODULES).toHaveLength(0);
  });

  it('every extension module id is present in the derived catalog', () => {
    // Empty upstream, so this is vacuously true here; it locks the contract that
    // extensions are spliced into the aggregate the registry derives from — a fork
    // relies on this to auto-expose its tools without editing registry.ts.
    const allIds = new Set(getAllToolIds());
    for (const mod of EXTENSION_TOOL_MODULES) {
      expect(allIds.has(mod.meta.id)).toBe(true);
    }
  });
});
