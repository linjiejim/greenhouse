import { it } from 'vitest';
import { assertPluginDisabled } from '../../../../apps/api/src/extensions/__tests__/disabled-helper.js';
it('contributes no surfaces while disabled', async () => {
  await assertPluginDisabled(
    'knowledge',
    ['/api/knowledge/docs', '/api/knowledge/search', '/api/knowledge/export'],
    ['knowledge_query', 'knowledge_mutation'],
  );
}, 60000);
