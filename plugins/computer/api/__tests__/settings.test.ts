import { it, expect } from 'vitest';
import '../../../../apps/api/src/extensions/index.js';
import { validateWorkspaceValue } from '../../../../apps/api/src/settings/workspace-config.js';
import { getWorkspaceSettingDef } from '@greenhouse/types/workspace-settings';
const def = (key: string) => getWorkspaceSettingDef(key)!;
it('accepts only well-formed cloud computer settings', () => {
  expect(validateWorkspaceValue(def('computer.enabled'), true).ok).toBe(true);
  expect(validateWorkspaceValue(def('computer.enabled'), 'maybe').ok).toBe(false);
  expect(validateWorkspaceValue(def('computer.max_running'), '5').ok).toBe(true);
  expect(validateWorkspaceValue(def('computer.max_running'), '0').ok).toBe(false);
  expect(validateWorkspaceValue(def('computer.max_running'), '2.5').ok).toBe(false);
  expect(validateWorkspaceValue(def('computer.domain'), 'cn-beijing-1.sandbox.ppio.com').ok).toBe(true);
  expect(validateWorkspaceValue(def('computer.domain'), 'https://e2b.app').ok).toBe(false);
  expect(validateWorkspaceValue(def('computer.template'), 'base').ok).toBe(true);
  expect(validateWorkspaceValue(def('computer.template'), 'a b').ok).toBe(false);
});
