import { it } from 'vitest';
import { assertPluginDisabled } from '../../../../apps/api/src/plugin-host/__tests__/disabled-helper.js';
it('contributes no surfaces when disabled', async () => {
  await assertPluginDisabled(
    'computer',
    ['/api/computer', '/api/admin/computers'],
    ['computer_exec', 'computer_files', 'computer_stop', 'computer_transfer'],
  );
}, 60000);
