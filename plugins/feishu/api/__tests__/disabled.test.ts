import { it } from 'vitest';
import { assertPluginDisabled } from '../../../../apps/api/src/plugin-host/__tests__/disabled-helper.js';
it('contributes no surfaces when disabled', async () => {
  await assertPluginDisabled(
    'feishu',
    ['/api/feishu/binding', '/api/feishu/oauth/start-login', '/api/feishu/oauth/exchange'],
    [],
  );
}, 60000);
