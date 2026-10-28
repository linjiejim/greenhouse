import { describe, expect, it } from 'vitest';
import {
  agentBody,
  agentDraftChanged,
  agentDraftFrom,
  agentGroups,
  agentRowId,
  agentSlug,
  automationsUsing,
  copyName,
  duplicateAgentDraft,
  newAgentDraft,
  toolPicker,
  validateAgentDraft,
  type CustomAgent,
} from './agents';

const ops: CustomAgent = {
  id: 'custom:01JOPS',
  name: 'Ops Bot',
  description: '值班助手',
  tools: ['knowledge_query', 'tables_mutation'],
  connectors: ['conn-team', 'conn-personal'],
  system_prompt: '你负责值班。',
  max_steps: 8,
  is_shared: false,
  is_custom: true,
  user_id: 'member',
  current_version: 3,
  risk_level: 'low',
  avatar: { plant: 'fern', tint: 'sky', accessories: ['hat'] },
  model_id: 'deep',
};

describe('lists', () => {
  it('splits mine from the team’s and leaves other members’ private agents out', () => {
    const agents: CustomAgent[] = [
      { ...ops, id: 'custom:b', name: 'Zed' },
      { ...ops, id: 'custom:a', name: 'Alpha' },
      { ...ops, id: 'custom:s', name: 'Shared', user_id: 'other', is_shared: true },
      { ...ops, id: 'custom:p', name: 'Private', user_id: 'other' },
    ];
    const groups = agentGroups(agents, 'member');
    expect(groups.mine.map((a) => a.name)).toEqual(['Alpha', 'Zed']);
    expect(groups.shared.map((a) => a.name)).toEqual(['Shared']);
    expect(agentGroups(agents, null).mine).toEqual([]);
  });

  it('counts the automations that run as an agent, whatever version they pinned', () => {
    expect(agentRowId('custom:01JOPS@4')).toBe('01JOPS');
    expect(
      automationsUsing('custom:01JOPS', [
        { profile_id: 'custom:01JOPS@2' },
        { profile_id: 'custom:01JOPS' },
        { profile_id: 'sprouty' },
        { profile_id: 'custom:01JOTHER@1' },
      ]),
    ).toBe(2);
  });
});

describe('names', () => {
  it('derives the station’s slug', () => {
    expect(agentSlug('Ops Bot')).toBe('ops-bot');
    expect(agentSlug('周报 助手!')).toBe('周报-助手');
    expect(agentSlug('!!!')).toBe('profile');
  });

  it('names a copy so its slug is still free', () => {
    const words = { one: '{name} (copy)', many: '{name} (copy {n})' };
    expect(copyName('Ops Bot', [{ name: 'Ops Bot' }], words)).toBe('Ops Bot (copy)');
    expect(copyName('Ops Bot', [{ name: 'Ops Bot' }, { name: 'ops bot copy' }], words)).toBe('Ops Bot (copy 2)');
  });
});

describe('drafts', () => {
  it('a new agent starts on the given model with the default limits', () => {
    expect(newAgentDraft('flash')).toMatchObject({
      modelId: 'flash',
      maxSteps: '12',
      riskLevel: 'medium',
      connectors: null,
      avatar: { plant: 'ivy' },
    });
  });

  it('opens an agent as it is stored', () => {
    expect(agentDraftFrom(ops, 'flash')).toMatchObject({
      name: 'Ops Bot',
      modelId: 'deep',
      prompt: '你负责值班。',
      maxSteps: '8',
      connectors: ['conn-team', 'conn-personal'],
      avatar: { plant: 'fern', tint: 'sky', accessories: ['hat'] },
    });
    expect(agentDraftFrom({ ...ops, model_id: undefined }, 'flash').modelId).toBe('flash');
  });

  it('a duplicate keeps only the tools I hold and the connectors I can use', () => {
    const copy = duplicateAgentDraft(
      { ...ops, user_id: 'other', is_shared: true },
      {
        name: 'Ops Bot (copy)',
        fallbackModel: 'flash',
        heldTools: ['knowledge_query'],
        usableConnectors: ['conn-team'],
      },
    );
    expect(copy).toMatchObject({ name: 'Ops Bot (copy)', tools: ['knowledge_query'], connectors: ['conn-team'] });
    expect(
      duplicateAgentDraft(ops, { name: 'x', fallbackModel: 'flash', heldTools: [], usableConnectors: null }).connectors,
    ).toBeNull();
  });

  it('checks the name, the instructions and the step budget', () => {
    const draft = { ...newAgentDraft('flash'), name: 'Writer', prompt: 'Write.' };
    expect(validateAgentDraft(draft, [])).toEqual({});
    expect(validateAgentDraft({ ...draft, name: '  ' }, [])).toEqual({ name: 'nameRequired' });
    expect(validateAgentDraft({ ...draft, name: 'ops bot' }, [ops])).toEqual({ name: 'nameTaken' });
    expect(validateAgentDraft({ ...draft, prompt: ' ' }, [])).toEqual({ prompt: 'promptRequired' });
    expect(validateAgentDraft({ ...draft, prompt: 'x'.repeat(8001) }, [])).toEqual({ prompt: 'promptLong' });
    expect(validateAgentDraft({ ...draft, maxSteps: '0' }, [])).toEqual({ maxSteps: 'maxSteps' });
    expect(validateAgentDraft({ ...draft, maxSteps: '51' }, [])).toEqual({ maxSteps: 'maxSteps' });
  });
});

describe('agentBody', () => {
  it('creates from the default preset with every field', () => {
    const draft = { ...newAgentDraft('flash'), name: ' Writer ', prompt: ' Write. ', tools: ['knowledge_query'] };
    expect(agentBody(draft)).toEqual({
      name: 'Writer',
      description: '',
      base_profile_id: 'sprouty',
      model_id: 'flash',
      tools: ['knowledge_query'],
      connectors: null,
      system_prompt: 'Write.',
      max_steps: 12,
      purpose: '',
      audience: '',
      risk_level: 'medium',
      avatar: draft.avatar,
    });
  });

  it('an edit sends only what changed, nothing when nothing did', () => {
    const original = agentDraftFrom(ops, 'flash');
    expect(agentBody({ ...original }, original)).toEqual({});
    expect(agentDraftChanged({ ...original }, original)).toBe(false);
    const edited = {
      ...original,
      prompt: '你负责周末值班。',
      connectors: null,
      avatar: { ...original.avatar, tint: 'rose' },
    };
    expect(agentBody(edited, original)).toEqual({
      system_prompt: '你负责周末值班。',
      connectors: null,
      avatar: { plant: 'fern', tint: 'rose', accessories: ['hat'] },
    });
  });
});

describe('toolPicker', () => {
  const tools = [
    { id: 'knowledge_query', name: 'Knowledge search', category: 'core' },
    { id: 'ask_user', name: 'Ask', category: 'core', builtin: true },
    { id: 'tables_mutation', name: 'Write tables', category: 'team', brief: 'Create records' },
    { id: 'users_admin', name: 'Users', category: 'admin' },
    { id: 'crm_query', name: 'CRM', category: 'crm' },
  ];

  it('groups the pickable tools and leaves built-ins out', () => {
    const picker = toolPicker(tools, [], '');
    expect(picker.groups.map((g) => [g.id, g.tools.map((t) => t.id)])).toEqual([
      ['core', ['knowledge_query']],
      ['team', ['tables_mutation']],
      ['admin', ['users_admin']],
      ['crm', ['crm_query']],
    ]);
    expect(picker.pickable).toEqual(['knowledge_query', 'tables_mutation', 'users_admin', 'crm_query']);
  });

  it('filters by name, id or brief and names selected tools I no longer hold', () => {
    const picker = toolPicker(tools, ['ask_user', 'gone_tool', 'knowledge_query'], 'record');
    expect(picker.groups.map((g) => g.tools.map((t) => t.id))).toEqual([['tables_mutation']]);
    expect(picker.missing).toEqual(['gone_tool']);
  });
});
