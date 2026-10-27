import { it } from 'vitest';
import { assertPluginDisabled } from '../../../../apps/api/src/plugin-host/__tests__/disabled-helper.js';
it('contributes no surfaces when disabled', async () => {
  await assertPluginDisabled('wecom', ['/api/wecom/binding', '/api/wecom/oauth/callback'], []);
}, 60000);
