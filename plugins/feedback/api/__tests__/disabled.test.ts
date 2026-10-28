import { it } from 'vitest';
import { assertPluginDisabled } from '../../../../apps/api/src/plugin-host/__tests__/disabled-helper.js';
it('contributes no surfaces when disabled', async () => {
  await assertPluginDisabled(
    'feedback',
    ['/api/admin/feature-requests', '/api/admin/frictions', '/api/me/feedback'],
    ['feedback_query', 'feature_request', 'log_friction'],
  );
}, 60000);
