import { it } from 'vitest';
import { assertPluginDisabled } from '../../../../apps/api/src/plugin-host/__tests__/disabled-helper.js';
it('contributes no surfaces while disabled', async () => {
  await assertPluginDisabled('retro', ['/api/admin/retro'], []);
}, 60000);
