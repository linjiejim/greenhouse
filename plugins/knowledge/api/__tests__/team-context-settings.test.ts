import { it, expect } from 'vitest';
import '../../../../apps/api/src/extensions/index.js';
import { getWorkspaceSettingDef } from '@greenhouse/types/workspace-settings';
import { validateWorkspaceValue } from '../../../../apps/api/src/settings/workspace-config.js';
const def = (key: string) => getWorkspaceSettingDef(key)!;
it('takes team context picks as document ids and the zone as an IANA name', () => {
  const conventions = validateWorkspaceValue(def('team_context.conventions'), [' how-we-work ', 'how-we-work', '规范']);
  expect(conventions).toEqual({ ok: true, value: ['how-we-work', '规范'] });
  expect(validateWorkspaceValue(def('team_context.conventions'), 'how-we-work').ok).toBe(false);
  expect(validateWorkspaceValue(def('team_context.conventions'), ['a/b']).ok).toBe(false);
  expect(
    validateWorkspaceValue(
      def('team_context.conventions'),
      Array.from({ length: 11 }, (_, index) => `doc-${index}`),
    ).ok,
  ).toBe(false);
  expect(validateWorkspaceValue(def('team_context.glossary'), 'terms').ok).toBe(true);
  expect(validateWorkspaceValue(def('team_context.glossary'), 'two words').ok).toBe(false);
  expect(validateWorkspaceValue(def('team_context.timezone'), 'Asia/Shanghai').ok).toBe(true);
  expect(validateWorkspaceValue(def('team_context.timezone'), 'Mars/Base').ok).toBe(false);
});
