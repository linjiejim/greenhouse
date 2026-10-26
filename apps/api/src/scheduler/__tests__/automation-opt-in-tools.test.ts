import { getAllToolIds } from '../../tools/registry.js';
/**
 * The opt-in grant's behavioural contract (spec 20260824-automation-optin-tools):
 * it adds only from the catalog, only within the owner's own permissions, only
 * for the scheduler, and only when a person — not a model — asked for it.
 */

import { describe, it, expect } from 'vitest';
import { filterUnattendedToolIds } from '../../agent-runtime/tool-resolution.js';
import { scheduledToolBase } from '../executor.js';
import { validateUnattendedTools, type TaskActor } from '../task-center.js';

const OWNER: TaskActor = { userId: 'u1', role: 'team', scope: 'own' };
const CONSOLE: TaskActor = { ...OWNER, scope: 'any', canGrantTools: true };

/** A realistic effective set: the automatic reads plus writes the owner holds. */
const EFFECTIVE = [
  'knowledge_query',
  'tables_query',
  'knowledge_query',
  'tables_mutation',
  'knowledge_mutation',
  'generate_image',
  'email_mutation',
  'automation_mutation',
  'tables_schema_plan',
  'report_templates',
  'report_render',
].filter((id) => getAllToolIds().includes(id));

describe('scheduledToolBase', () => {
  it('is read-only when nothing was granted', () => {
    const base = scheduledToolBase(EFFECTIVE);
    expect(base.includes('tables_query')).toBe(EFFECTIVE.includes('tables_query'));
    expect(base).not.toContain('tables_mutation');
    expect(base).not.toContain('generate_image');
    // Reading the team's report templates is replay-safe; rendering one is not.
    expect(base.includes('report_templates')).toBe(EFFECTIVE.includes('report_templates'));
    expect(base).not.toContain('report_render');
  });

  it('lets the owner grant report rendering for a scheduled report', () => {
    const base = scheduledToolBase(EFFECTIVE, ['report_render']);
    expect(base.includes('report_render')).toBe(EFFECTIVE.includes('report_render'));
    expect(base.includes('report_templates')).toBe(EFFECTIVE.includes('report_templates'));
    expect(base).not.toContain('tables_mutation');
  });

  it('adds exactly what was granted, and keeps the automatic reads', () => {
    const base = scheduledToolBase(EFFECTIVE, ['tables_mutation']);
    expect(base.includes('tables_mutation')).toBe(EFFECTIVE.includes('tables_mutation'));
    expect(base.includes('tables_query')).toBe(EFFECTIVE.includes('tables_query'));
    expect(base).not.toContain('knowledge_mutation');
  });

  it('cannot grant a tool the owner does not have', () => {
    // The grant is a filter over effectiveTools, never a permission of its own.
    const base = scheduledToolBase(['knowledge_query'], ['knowledge_mutation']);
    expect(base).not.toContain('knowledge_mutation');
    expect(base).toEqual(['knowledge_query']);
  });

  it('cannot reach a denylisted or draft-only tool even when stored', () => {
    const base = scheduledToolBase(EFFECTIVE, ['email_mutation', 'automation_mutation', 'tables_schema_plan']);
    expect(base).not.toContain('email_mutation');
    expect(base).not.toContain('automation_mutation');
    expect(base).not.toContain('tables_schema_plan');
  });

  it('ignores a corrupt or unknown grant instead of failing the run', () => {
    expect(scheduledToolBase(EFFECTIVE, ['no_such_tool'])).toEqual(scheduledToolBase(EFFECTIVE));
  });
});

describe('the grant does not leak to other callers', () => {
  it('a bare filter call stays read-only', () => {
    expect(filterUnattendedToolIds(EFFECTIVE)).not.toContain('tables_mutation');
  });
});

describe('validateUnattendedTools', () => {
  it('refuses a model, and says where the user should go instead', () => {
    const result = validateUnattendedTools(['tables_mutation'], OWNER);
    expect(result).toMatchObject({ ok: false, code: 'forbidden' });
    expect((result as { error: string }).error).toContain('Automations');
  });

  it('refuses an id outside the catalog and quotes it', () => {
    const result = validateUnattendedTools(['email_mutation'], CONSOLE);
    expect(result).toMatchObject({ ok: false, code: 'invalid' });
    expect((result as { error: string }).error).toContain('"email_mutation"');
    // The message must also say what IS grantable, or the caller is guessing.
    expect((result as { error: string }).error).toContain('knowledge_mutation');
  });

  it('accepts a catalogued grant and canonicalises it', () => {
    const result = validateUnattendedTools(['knowledge_mutation', 'analyze_image', 'analyze_image'], CONSOLE);
    expect(result).toEqual({ tools: ['analyze_image', 'knowledge_mutation'] });
  });

  it('distinguishes "not supplied" from "supplied empty"', () => {
    // undefined must leave a stored grant alone on update; [] must clear it.
    expect(validateUnattendedTools(undefined, CONSOLE)).toBeUndefined();
    expect(validateUnattendedTools([], CONSOLE)).toEqual({ tools: [] });
  });

  it('refuses a non-array without throwing', () => {
    expect(validateUnattendedTools('tables_mutation' as unknown as string[], CONSOLE)).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});
