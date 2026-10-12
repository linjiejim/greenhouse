import { describe, expect, it } from 'vitest';
import type { PlatformApplication } from './catalog.js';
import { buildPrimaryNavigation } from './navigation.js';

function application(id: string): PlatformApplication {
  return {
    id,
    version: '1.0.0',
    title: id[0].toUpperCase() + id.slice(1),
    modules: {},
    actions: {},
    navigation: [{ id, title: id, module: 'main', path: `/${id}` }],
    capabilities: [],
  };
}

const baseLabels = {
  chatLabel: 'Chat',
  skillhubLabel: 'SkillHub',
};

describe('Primary navigation', () => {
  it('keeps the fixed shell order and drops apps without a registered host UI', () => {
    const { primary, overflow } = buildPrimaryNavigation({
      applications: [
        application('analytics'),
        application('tables'),
        application('knowledge'),
        application('projects'),
      ],
      ...baseLabels,
    });

    expect(primary.map((item) => item.key)).toEqual(['chat', 'knowledge', 'projects', 'tables']);
    // Agent/MCP-only catalog entries have no browser route, so they never
    // surface as a tab — not even in More.
    expect(overflow.map((item) => item.key)).toEqual(['skillhub']);
  });

  it('omits unauthorized apps from the primary tabs', () => {
    const { primary } = buildPrimaryNavigation({
      applications: [application('knowledge')],
      ...baseLabels,
    });

    expect(primary.map((item) => item.key)).toEqual(['chat', 'knowledge']);
  });

  it('leads with Chat — the workbench lives in its empty state, not a Home tab', () => {
    const { primary } = buildPrimaryNavigation({ applications: [application('knowledge')], ...baseLabels });
    expect(primary[0].key).toBe('chat');
    expect(primary.map((item) => item.key)).not.toContain('home');
  });

  it('keeps one conversations entry: a new chat without Agents, the main thread with them', () => {
    const without = buildPrimaryNavigation({ applications: [application('knowledge')], ...baseLabels });
    expect(without.primary.map((item) => item.key)).toEqual(['chat', 'knowledge']);
    expect(without.primary[0].href).toBe('#/chat');
    expect(without.primary[0].badge).toBeUndefined();

    const withAgents = buildPrimaryNavigation({
      applications: [application('knowledge'), application('projects')],
      ...baseLabels,
      bots: {},
    });
    // No separate Agents entry: their threads live in the one conversations list.
    expect(withAgents.primary.map((item) => item.key)).toEqual(['chat', 'knowledge', 'projects']);
    expect(withAgents.primary[0].href).toBe('#/bots');
    expect(withAgents.primary[0].badge).toBeUndefined();
    expect(withAgents.overflow.map((item) => item.key)).toEqual(['skillhub']);
  });

  it('carries the pending "needs you" count on the conversations entry', () => {
    const { primary } = buildPrimaryNavigation({ applications: [], ...baseLabels, bots: { badge: 3 } });
    expect(primary.find((item) => item.key === 'chat')?.badge).toBe(3);
    expect(primary.find((item) => item.key === 'bots')).toBeUndefined();
  });

  it('keeps durable executions out of More because they have one fixed utility entry', () => {
    const navigation = buildPrimaryNavigation({ applications: [], ...baseLabels });
    expect(navigation.overflow.map((item) => item.key)).toEqual(['skillhub']);
    expect(navigation.overflow.map((item) => item.href)).not.toContain('#/missions');
  });
});
