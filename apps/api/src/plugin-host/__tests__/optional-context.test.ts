import { expect, it, vi } from 'vitest';
import type { AgentContextCaller } from '../agent-context.js';
const calls = vi.hoisted(() => ({ changed: vi.fn(async () => {}), next: new Date('2026-11-01T01:00:00Z') }));
vi.stubEnv('GREENHOUSE_EXTENSIONS', 'context-fixture');
vi.mock('../compiled.generated.js', () => ({
  COMPILED_PLUGINS: [
    {
      id: 'context-fixture',
      name: 'Context fixture',
      sdk: 2,
      core: '>=3 <5',
      tools: [
        {
          kind: 'lazy',
          createLazy: () => ({}),
          meta: {
            id: 'fixture_query',
            name: 'Fixture',
            brief: 'Fixture',
            description: 'Fixture',
            category: 'core',
            is_global: true,
            icon: 'Box',
            sort_order: 0,
          },
        },
      ],
      teamContextSources: [
        {
          toolIds: ['fixture_query'],
          resolve: async () => ({
            conventions: [{ doc_id: 'fixture', title: 'Fixture', content: 'Team rules', updated_at: null }],
            glossary: null,
            refs: { conventions: [], glossary: null },
          }),
          validate: async () => ({ ok: true }),
          candidates: async () => [{ doc_id: 'fixture', title: 'Fixture' }],
        },
      ],
      workspaceTimeZoneChanged: [calls.changed],
      schedules: [{ nextRun: () => calls.next }],
      settingValueValidators: [
        (key: string, value: unknown) =>
          key === 'fixture.ids' ? { ok: true, value: Array.isArray(value) ? [...new Set(value)] : [] } : null,
      ],
      mcpResources: [
        {
          toolIds: ['fixture_query'],
          list: async () => [{ uri: 'greenhouse://fixture/doc', name: 'fixture-doc' }],
          templates: async () => [{ uriTemplate: 'greenhouse://fixture/{id}', name: 'fixture-doc' }],
          read: async (uri: string) =>
            uri === 'greenhouse://fixture/doc' ? { uri, mimeType: 'text/markdown', text: 'Scoped content' } : undefined,
        },
      ],
      toolResults: [
        {
          toolId: 'fixture_query',
          summarizeOutput: (output: Record<string, unknown>) => ({ count: output.count }),
          references: () => [{ slug: 'fixture', title: 'Fixture', type: 'kb_doc' }],
        },
      ],
      activity: [{ writeRisks: { fixture_write: () => 'r1' } }],
    },
  ],
}));
it('feeds the existing context, protocol, settings, transcript and schedule consumers from one active fixture', async () => {
  const extensions = await import('../index.js');
  const settings = await import('../../hub-context/settings.js');
  const protocol = await import('../mcp-resources.js');
  const kernel = await import('@greenhouse/agent-core');
  const validation = await import('../../settings/validation-registry.js');
  const risk = await import('../../agent-access/risk.js');
  const caller = {
    db: {},
    userId: 'member',
    role: 'team',
    actor: {},
    reachable: new Set(['fixture_query']),
  } as unknown as AgentContextCaller;
  expect((await settings.resolveTeamContextDocs(caller.db)).conventions[0].content).toBe('Team rules');
  expect(await settings.validateTeamContextSelection(caller.db, { conventions: ['fixture'], glossary: null })).toEqual({
    ok: true,
  });
  expect(await protocol.listPluginResources(caller)).toHaveLength(1);
  expect(await protocol.listPluginResourceTemplates(caller)).toHaveLength(1);
  expect(await protocol.readPluginResource('greenhouse://fixture/doc', caller)).toMatchObject({
    text: 'Scoped content',
  });
  const denied = { ...caller, reachable: new Set<string>() };
  expect(await protocol.listPluginResources(denied)).toEqual([]);
  expect(await protocol.listPluginResourceTemplates(denied)).toEqual([]);
  expect(await protocol.readPluginResource('greenhouse://fixture/doc', denied)).toBeUndefined();
  expect(kernel.summarizeOutput('fixture_query', { count: 3, body: 'large' })).toEqual({ count: 3 });
  expect(kernel.toolResultReferences('fixture_query', {})).toHaveLength(1);
  expect(kernel.toolResultReferences('fixture_query', { error: 'denied' })).toEqual([]);
  expect(risk.classifyWrite('fixture_write', { action: 'remove' }).risk).toBe('r3');
  expect(risk.classifyWrite('fixture_write', { action: 'create' }).risk).toBe('r1');
  expect(validation.workspaceSettingValueValidators()[0]('fixture.ids', ['a', 'a'])).toEqual({
    ok: true,
    value: ['a'],
  });
  await extensions.fromExtensions('workspaceTimeZoneChanged')[0]();
  expect(calls.changed).toHaveBeenCalledOnce();
  expect(extensions.fromExtensions('schedules')[0].nextRun()).toEqual(calls.next);
  vi.unstubAllEnvs();
});
