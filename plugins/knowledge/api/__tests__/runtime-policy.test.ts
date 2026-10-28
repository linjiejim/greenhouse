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

  it('runs a migrated custom Agent on knowledge_query; a retired name grants nothing', async () => {
    const run = (tools: string[]) =>
      resolveEffectiveTools({
        userId: 'super-1',
        userRole: 'super',
        profileId: 'custom:legacy',
        profile: { id: 'custom:legacy', access: { level: 'internal', rich_output: false }, tools } as AgentProfile,
      });
    // Core migration 0004 rewrote team_knowledge / personal_knowledge to knowledge_query.
    expect((await run(['knowledge_query'])).effectiveTools).toContain('knowledge_query');
    const retired = (await run(['team_knowledge', 'personal_knowledge'])).effectiveTools;
    expect(retired).not.toContain('knowledge_query');
    expect(retired).not.toContain('team_knowledge');
    expect(retired).not.toContain('personal_knowledge');
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
