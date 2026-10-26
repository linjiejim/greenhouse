import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerAgentContexts,
  resolveAgentPromptFragments,
  listAgentResources,
  readAgentResource,
  listAgentPrompts,
  getAgentPrompt,
  type AgentContextCaller,
} from '../agent-context.js';

const caller = (tools: string[]): AgentContextCaller => ({
  db: {} as never,
  userId: 'member',
  role: 'team',
  reachable: new Set(tools),
  actor: { actorId: 'member', actorType: 'human', orgId: 'default', requestId: 'test', authMethod: 'bearer' },
});
const read = vi.fn(() => 'Private vocabulary');
const render = vi.fn((args: Readonly<Record<string, string>>) => `Review ${args.topic}`);
beforeEach(() => {
  vi.clearAllMocks();
  registerAgentContexts([
    {
      id: 'fixture',
      toolIds: ['fixture_query'],
      context: {
        promptFragment: () => 'stable'.repeat(500),
        resources: [{ name: 'vocabulary', title: 'Vocabulary', description: 'Domain terms', read }],
        prompts: [{ name: 'review', title: 'Review', arguments: [{ name: 'topic', required: true }], render }],
      },
    },
  ]);
});
describe('agentContext reachability', () => {
  it('injects only for actual plugin tools and caps each stable fragment at 2000 characters', async () => {
    expect(await resolveAgentPromptFragments(caller(['unrelated']))).toBeNull();
    expect(await resolveAgentPromptFragments(caller(['fixture_query']))).toHaveLength(2000);
    expect(await resolveAgentPromptFragments(caller(['fixture_query']))).toEqual(
      await resolveAgentPromptFragments(caller(['fixture_query'])),
    );
  });
  it('hides resources and prompts from grants or members without reachable plugin tools', async () => {
    const denied = caller([]);
    expect(listAgentResources(denied)).toEqual([]);
    expect(await readAgentResource(denied, 'greenhouse://ext/fixture/vocabulary')).toBeUndefined();
    expect(await listAgentPrompts(denied)).toEqual([]);
    expect(await getAgentPrompt(denied, 'ext-fixture-review', { topic: 'plans' })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });
  it('names MCP contributions and reads them through the same gate on every request', async () => {
    const allowed = caller(['fixture_query']);
    expect(listAgentResources(allowed)).toEqual([
      expect.objectContaining({ uri: 'greenhouse://ext/fixture/vocabulary' }),
    ]);
    expect(await readAgentResource(allowed, 'greenhouse://ext/fixture/vocabulary')).toMatchObject({
      text: 'Private vocabulary',
    });
    expect(await listAgentPrompts(allowed)).toEqual([
      expect.objectContaining({ name: 'ext-fixture-review', arguments: [{ name: 'topic', required: true }] }),
    ]);
    expect(await getAgentPrompt(allowed, 'ext-fixture-review', { topic: 'plans' })).toMatchObject({
      messages: [{ role: 'user', content: { type: 'text', text: 'Review plans' } }],
    });
    expect(await readAgentResource(caller([]), 'greenhouse://ext/fixture/vocabulary')).toBeUndefined();
  });
});

it('retains explicit protocol aliases without leaking them to a grant without the owner tool', async () => {
  registerAgentContexts([
    {
      id: 'fixture',
      toolIds: ['read_fixture'],
      context: {
        legacyPromptPrefixes: ['legacy-'],
        prompts: [{ name: 'guide', legacyName: 'legacy-guide', title: 'Guide', render: () => 'Guide' }],
      },
    },
  ]);
  expect((await listAgentPrompts(caller(['read_fixture']))).map((p) => p.name)).toEqual(['legacy-guide']);
  expect(await getAgentPrompt(caller([]), 'legacy-guide', {})).toBeNull();
});

it('resolves a dynamic prompt beyond the listing limit only through its reachable owner', async () => {
  const get = vi.fn(async () => ({
    description: 'Older guide',
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'Guide' } }],
  }));
  registerAgentContexts([
    {
      id: 'fixture',
      toolIds: ['read_fixture', 'write_fixture'],
      context: {
        toolIds: ['read_fixture'],
        prompts: [{ list: async () => [], get }],
      },
    },
  ]);
  expect(await getAgentPrompt(caller(['write_fixture']), 'ext-fixture-older', {})).toBeNull();
  expect(await getAgentPrompt(caller(['read_fixture']), 'ext-other-older', {})).toBeNull();
  expect(get).not.toHaveBeenCalled();
  expect(await listAgentPrompts(caller(['read_fixture']))).toEqual([]);
  expect(await getAgentPrompt(caller(['read_fixture']), 'ext-fixture-older', {})).toMatchObject({
    description: 'Older guide',
  });
  expect(get).toHaveBeenCalledOnce();
});
