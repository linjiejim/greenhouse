import { it } from 'vitest';
import { assertPluginDisabled } from '../../../../apps/api/src/extensions/__tests__/disabled-helper.js';
it('contributes no surfaces when disabled', async () => {
  await assertPluginDisabled('reports', ['/api/report-templates'], ['report_templates', 'report_render']);
}, 60000);
