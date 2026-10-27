import { it } from 'vitest';
import { assertPluginDisabled } from '../../../../apps/api/src/plugin-host/__tests__/disabled-helper.js';
it('contributes no surfaces when disabled', async () => {
  await assertPluginDisabled('email', ['/api/email/accounts', '/api/email/shared'], ['email_query', 'email_mutation']);
}, 60000);
