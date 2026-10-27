import { it } from 'vitest';
import { assertPluginDisabled } from '../../../../apps/api/src/plugin-host/__tests__/disabled-helper.js';
it('contributes no surfaces when disabled', async () => {
  await assertPluginDisabled(
    'tables',
    ['/api/tables/bases'],
    ['tables_query', 'tables_mutation', 'tables_schema_plan'],
  );
}, 60000);
