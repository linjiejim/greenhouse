import { expect, it, vi } from 'vitest';
import type { TeamContextCaller } from './team-context.js';
vi.mock('../settings/workspace-config.js', async (original) => ({
  ...(await original<typeof import('../settings/workspace-config.js')>()),
  getWorkspaceValue: async (key: string) =>
    (
      ({
        'team_context.overview_markdown': '# Our team\nWorkspace overview',
        'team_context.conventions_markdown': 'Use reviewed changes.',
        'team_context.glossary_markdown': 'A station is one server.',
        'team_context.conventions': ['old-document'],
        'team_context.glossary': 'old-glossary',
        'branding.product_name': 'Fixture',
      }) as Record<string, unknown>
    )[key],
}));
vi.mock('./catalog.js', () => ({ buildDataCatalog: async () => ({ bases: [], extensions: [], truncated: false }) }));
vi.mock('./prompts.js', () => ({ listTeamPrompts: async () => [] }));
import { registerTeamContextDocumentSources } from './settings.js';
import { buildTeamContextBundle, listContextResources, readContextResource } from './team-context.js';
it('serves workspace Markdown with no document plugin and no optional tool grant', async () => {
  registerTeamContextDocumentSources([]);
  const caller = {
    db: { users: { getById: async () => ({ nickname: 'Member' }) } },
    userId: 'member',
    role: 'team',
    reachable: new Set(),
    actor: {},
  } as unknown as TeamContextCaller;
  const resources = await listContextResources(caller);
  expect(resources.map((r) => r.uri)).toEqual([
    'greenhouse://context/overview',
    'greenhouse://context/conventions',
    'greenhouse://context/glossary',
  ]);
  expect((await readContextResource(caller, 'greenhouse://context/overview'))?.text).toContain('Workspace overview');
  expect((await readContextResource(caller, 'greenhouse://context/conventions'))?.text).toContain(
    'Use reviewed changes.',
  );
  const bundle = await buildTeamContextBundle(caller);
  expect(bundle.overview).toContain('Workspace overview');
  expect(bundle.conventions[0].content).toBe('Use reviewed changes.');
  expect(bundle.glossary?.content).toBe('A station is one server.');
  expect(JSON.stringify(bundle)).not.toContain('old-document');
});
