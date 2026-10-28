import { describe, expect, it } from 'vitest';
import { registerToolResultAdapters } from '@greenhouse/agent-core';
import { knowledgeTranscript } from '../transcript.js';
import { executeProxyTool } from '../../../../apps/api/src/agent-runtime/tool-proxy.js';
import {
  resolveEffectiveTools,
  filterBrowserSessionToolIds,
} from '../../../../apps/api/src/agent-runtime/tool-resolution.js';
import type { AgentProfile } from '../../../../apps/api/src/profiles/profile.js';
import { normalizeAutomationOptInTools } from '@greenhouse/types/automation-tools';
import { scheduledToolBase } from '../../../../apps/api/src/scheduler/executor.js';

registerToolResultAdapters([knowledgeTranscript]);

describe('knowledge runtime policy contributions', () => {
  it('refuses a retired read name on the proxy', async () => {
    const registry = { knowledge_query: { execute: async (input: unknown) => input } };
    await expect(
      executeProxyTool(registry, 'search_team_knowledge', ['knowledge_query'], { query: 'nutrient' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('keeps stored profile aliases meaningful while the plugin is enabled', async () => {
    const { effectiveTools } = await resolveEffectiveTools({
      userId: 'super-1',
      userRole: 'super',
      profileId: 'custom:legacy',
      profile: {
        id: 'custom:legacy',
        access: { level: 'internal', rich_output: false },
        tools: ['team_knowledge', 'personal_knowledge'],
      } as AgentProfile,
    });
    expect(effectiveTools).toContain('knowledge_query');
    expect(effectiveTools).not.toContain('team_knowledge');
    expect(effectiveTools).not.toContain('personal_knowledge');
  });

  it('offers reads to browser and scheduled runs, and requires a grant for writes', () => {
    const ids = ['knowledge_query', 'knowledge_mutation'];
    expect(filterBrowserSessionToolIds(ids)).toEqual(['knowledge_query']);
    expect(scheduledToolBase(ids)).toEqual(['knowledge_query']);
    expect(normalizeAutomationOptInTools(['knowledge_mutation', 'knowledge_mutation', 7])).toEqual([
      'knowledge_mutation',
    ]);
    expect(scheduledToolBase(ids, ['knowledge_mutation'])).toEqual(ids);
  });
});
