import { describe, expect, it } from 'vitest';
import { getWorkspaceSettingDef } from '@greenhouse/types/workspace-settings';

import { validateWorkspaceValue } from '../../settings/workspace-config.js';

describe('bots computer knobs (Runtime Config write path)', () => {
  const idle = getWorkspaceSettingDef('bots.computer_idle_minutes')!;
  const max = getWorkspaceSettingDef('bots.computer_max_running')!;

  it('accepts whole numbers in range and canonicalises them', () => {
    expect(validateWorkspaceValue(idle, ' 30 ')).toEqual({ ok: true, value: '30' });
    expect(validateWorkspaceValue(idle, '005')).toEqual({ ok: true, value: '5' });
    expect(validateWorkspaceValue(max, '50')).toEqual({ ok: true, value: '50' });
  });

  it('rejects out-of-range, fractional and non-numeric values with the range in the message', () => {
    // Longer than the field allows: refused before the range check.
    expect(validateWorkspaceValue(idle, 'fifteen').ok).toBe(false);
    for (const bad of ['4', '241', '7.5', 'ten', '-5']) {
      const result = validateWorkspaceValue(idle, bad);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/5 to 240/);
    }
    for (const bad of ['0', '51', '2.5']) {
      const result = validateWorkspaceValue(max, bad);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/1 to 50/);
    }
  });
});
