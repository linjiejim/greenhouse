/**
 * Guard for the Automation opt-in tool catalog.
 *
 * The catalog lives in `@greenhouse/types` rather than on each tool's `defineTool`
 * meta (spec D12: task-center cannot import the tool registry without closing
 * an import cycle). That trade costs the compile-time "every new tool must
 * answer" property, so these assertions buy it back: every catalogued id must
 * really exist, and the catalog must stay disjoint from the sets that exist to
 * keep tools OUT of an unattended run.
 */

import { describe, it, expect } from 'vitest';
import { AUTOMATION_OPT_IN_TOOLS, normalizeAutomationOptInTools } from '@greenhouse/types/automation-tools';
import { getAllToolIds } from '../../tools/registry.js';
import {
  DISPATCH_TOOL_IDS,
  filterUnattendedToolIds,
  UNATTENDED_TOOL_DENYLIST,
} from '../../agent-runtime/tool-resolution.js';

describe('automation opt-in catalog', () => {
  const ids = AUTOMATION_OPT_IN_TOOLS.map((tool) => tool.id);

  it('only lists tools that exist', () => {
    const known = new Set(getAllToolIds());
    for (const id of ids) expect(known, `unknown tool id "${id}"`).toContain(id);
  });

  it('has no duplicates', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never overlaps the unattended denylist', () => {
    // email_mutation and automation_mutation are refused for reasons a one-time
    // consent cannot answer (irreversible outbound, self-multiplication).
    for (const id of ids) expect(UNATTENDED_TOOL_DENYLIST.has(id), `"${id}" is denylisted`).toBe(false);
  });

  it('never overlaps the draft-only dispatch tools', () => {
    for (const id of ids) expect(DISPATCH_TOOL_IDS, `"${id}" only drafts a card`).not.toContain(id);
  });

  it('never lists a tool that is already allowed automatically', () => {
    // A catalogued read would be a checkbox with no effect: it is granted
    // whether or not the box is ticked.
    const automatic = filterUnattendedToolIds(ids);
    expect(automatic).toEqual([]);
  });

  it('the three refused write tools are absent by name', () => {
    // Named explicitly so removing them from the denylist alone cannot quietly
    // make them grantable.
    for (const id of ['email_mutation', 'automation_mutation', 'skill_mutation']) {
      expect(ids).not.toContain(id);
    }
  });
});

describe('normalizeAutomationOptInTools', () => {
  it('drops unknown ids, duplicates and non-strings', () => {
    expect(normalizeAutomationOptInTools(['tables_mutation', 'tables_mutation', 'email_mutation', 7, null])).toEqual([
      'tables_mutation',
    ]);
  });

  it('returns [] for anything that is not an array', () => {
    expect(normalizeAutomationOptInTools('tables_mutation')).toEqual([]);
    expect(normalizeAutomationOptInTools(undefined)).toEqual([]);
    expect(normalizeAutomationOptInTools({ 0: 'tables_mutation' })).toEqual([]);
  });

  it('is order-stable regardless of input order', () => {
    const a = normalizeAutomationOptInTools(['crm_mutation', 'memory']);
    const b = normalizeAutomationOptInTools(['memory', 'crm_mutation']);
    expect(a).toEqual(b);
  });
});
