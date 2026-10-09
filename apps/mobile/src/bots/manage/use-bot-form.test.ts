/**
 * The Bot form's rules (./bot-form-model.ts — the pure half of
 * ./use-bot-form.ts; spec docs/specs/20261008-mobile-bots.md §8 E): the four
 * pre-fills (template / custom / proposal / edit) and when each is ready, an
 * edit sending only what changed, where a refused save is explained, when ✓
 * is live, and the computer warning.
 */

import { describe, expect, it } from 'vitest';
import { BOT_TEMPLATES, type BotRequestView, type BotView, type ComputerRuntimeView } from '../../shared/bots';
import { legacyToPlant } from '../../ui/plant-avatar/plant-ids';
import {
  botFormCanSave,
  botFormDirty,
  botFormTitle,
  botSaveFailure,
  botValues,
  createInput,
  nameIssueKey,
  needsComputerWarning,
  proposalDecision,
  resolveBotForm,
  updatePatch,
  type BotFormValues,
} from './bot-form-model';
import { botPlant } from './plant-pick';

function bot(over: Partial<BotView> & Pick<BotView, 'id'>): BotView {
  return {
    name: 'Sage',
    role: 'Helper',
    description: 'Helps',
    instructions: 'Be kind.',
    avatar: { plant: 'sage' },
    model_id: null,
    tools: null,
    max_steps: null,
    template_key: null,
    status: 'active',
    dm_session_id: null,
    current_version: 1,
    user_id: 'u1',
    last_active_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function proposal(over: Partial<BotRequestView> = {}): BotRequestView {
  return {
    id: 'r1',
    session_id: 's1',
    bot_id: 'sprouty-bot',
    kind: 'bot_create',
    status: 'pending',
    payload: {
      name: '卷卷',
      role: '写手',
      instructions: '写得简洁。',
      avatar: { plant: 'fern' },
      template_key: 'writer',
    },
    result: null,
    expires_at: null,
    created_at: '2026-10-08T00:00:00.000Z',
    ...over,
  };
}

const sprouty = bot({ id: 'sprouty-bot', name: 'Sprouty', template_key: 'sprouty', avatar: {} });
const sage = bot({ id: 'b-sage' });
const old = bot({ id: 'b-old', name: 'Old', status: 'archived' });

function data(over: Partial<Parameters<typeof resolveBotForm>[1]> = {}): Parameters<typeof resolveBotForm>[1] {
  const bots = [sprouty, sage];
  return {
    bots,
    byId: Object.fromEntries([...bots, old].map((b) => [b.id, b])),
    botsLoaded: true,
    requests: new Map(),
    pendingChecked: false,
    lang: 'zh',
    ...over,
  };
}

const ready = (source: ReturnType<typeof resolveBotForm>) => {
  if (source.status !== 'ready') throw new Error(`expected ready, got ${source.status}`);
  return source.init;
};

describe('pre-fill', () => {
  it('waits for the Bot list in every mode', () => {
    for (const params of [{}, { template: 'writer' }, { botId: 'b-sage' }, { requestId: 'r1' }]) {
      expect(resolveBotForm(params, data({ botsLoaded: false })).status).toBe('loading');
    }
  });

  it('a gallery template fills its copy in the app language and pins its plant', () => {
    const writer = BOT_TEMPLATES.find((t) => t.key === 'writer')!;
    const init = ready(resolveBotForm({ template: 'writer' }, data()));
    expect(init.mode).toBe('create');
    expect(init.templateKey).toBe('writer');
    expect(init.values).toMatchObject({
      name: writer.copy.zh.name,
      role: writer.copy.zh.role,
      description: writer.copy.zh.pitch,
      instructions: writer.copy.zh.instructions,
    });
    expect(init.values.avatar.plant).toBe('fern');
    expect(botFormTitle(init, 'zh')).toEqual({ key: 'bots.manage.formTemplate', vars: { role: '写手' } });
    expect(ready(resolveBotForm({ template: 'writer' }, data({ lang: 'en' }))).values.name).toBe(writer.copy.en.name);
  });

  it('custom (or an unknown / non-gallery template) is blank with a plant nobody wears', () => {
    for (const template of [undefined, 'custom', 'sprouty', 'chief', 'nope']) {
      const init = ready(resolveBotForm({ template }, data()));
      expect(init.templateKey).toBeNull();
      expect(init.values).toMatchObject({ name: '', role: '', description: '', instructions: '' });
      const plant = legacyToPlant(init.values.avatar);
      expect([sprouty, sage].map(botPlant)).not.toContain(plant);
      expect(botFormTitle(init, 'zh')).toEqual({ key: 'bots.manage.formNew' });
    }
  });

  it('a proposal fills the payload, without a purpose', () => {
    const request = proposal();
    const init = ready(resolveBotForm({ requestId: 'r1' }, data({ requests: new Map([['r1', request]]) })));
    expect(init.mode).toBe('proposal');
    expect(init.request).toBe(request);
    expect(init.templateKey).toBe('writer');
    expect(init.values).toEqual({
      name: '卷卷',
      role: '写手',
      description: '',
      instructions: '写得简洁。',
      avatar: { plant: 'fern' },
    });
    expect(botFormTitle(init, 'zh')).toEqual({ key: 'bots.manage.formProposal' });
  });

  it('a proposal not (yet) in the pending list waits for one re-read, then is gone', () => {
    expect(resolveBotForm({ requestId: 'r1' }, data()).status).toBe('loading');
    expect(resolveBotForm({ requestId: 'r1' }, data({ pendingChecked: true })).status).toBe('missing');
    const decided = new Map([['r1', proposal({ status: 'resolved' })]]);
    expect(resolveBotForm({ requestId: 'r1' }, data({ requests: decided })).status).toBe('missing');
    const otherKind = new Map([['r1', proposal({ kind: 'approval' })]]);
    expect(resolveBotForm({ requestId: 'r1' }, data({ requests: otherKind })).status).toBe('missing');
  });

  it('an edit fills the Bot as stored; an archived or unknown Bot is missing', () => {
    const init = ready(resolveBotForm({ botId: 'b-sage' }, data()));
    expect(init.mode).toBe('edit');
    expect(init.bot).toBe(sage);
    expect(init.values).toEqual(botValues(sage));
    expect(botFormTitle(init, 'en')).toEqual({ key: 'bots.manage.formEdit' });
    expect(resolveBotForm({ botId: 'b-old' }, data()).status).toBe('missing');
    expect(resolveBotForm({ botId: 'b-none' }, data()).status).toBe('missing');
  });
});

describe('an edit sends only what changed', () => {
  const values = (over: Partial<BotFormValues>): BotFormValues => ({ ...botValues(sage), ...over });

  it('nothing changed → empty patch', () => {
    expect(updatePatch(sage, values({}))).toEqual({});
    // Surrounding whitespace is not a change (the server trims).
    expect(updatePatch(sage, values({ role: '  Helper ' }))).toEqual({});
  });

  it('only the edited fields, trimmed', () => {
    expect(updatePatch(sage, values({ role: ' Researcher ' }))).toEqual({ role: 'Researcher' });
    expect(updatePatch(sage, values({ name: 'Basil', instructions: 'New.' }))).toEqual({
      name: 'Basil',
      instructions: 'New.',
    });
  });

  it('the avatar only when a key changed, whatever the key order', () => {
    const stored = bot({ id: 'b2', avatar: { plant: 'sage', faceStyle: 'happy' } });
    expect(updatePatch(stored, { ...botValues(stored), avatar: { faceStyle: 'happy', plant: 'sage' } })).toEqual({});
    expect(updatePatch(stored, { ...botValues(stored), avatar: { plant: 'lotus', faceStyle: 'happy' } })).toEqual({
      avatar: { plant: 'lotus', faceStyle: 'happy' },
    });
  });
});

describe('create and accept bodies', () => {
  const values: BotFormValues = {
    name: ' Fernie ',
    role: ' Writer ',
    description: ' Drafts ',
    instructions: ' Be brief. ',
    avatar: { plant: 'fern' },
  };

  it('a gallery template sends its key; custom and non-gallery keys send none', () => {
    expect(createInput({ templateKey: 'writer' }, values)).toEqual({
      template_key: 'writer',
      name: 'Fernie',
      role: 'Writer',
      description: 'Drafts',
      instructions: 'Be brief.',
      avatar: { plant: 'fern' },
    });
    expect(createInput({ templateKey: null }, values)).not.toHaveProperty('template_key');
    expect(createInput({ templateKey: 'sprouty' }, values)).not.toHaveProperty('template_key');
  });

  it('accepting a proposal sends the edited fields, never a purpose', () => {
    expect(proposalDecision(values)).toEqual({
      decision: 'approve',
      bot: { name: 'Fernie', role: 'Writer', instructions: 'Be brief.', avatar: { plant: 'fern' } },
    });
  });
});

describe('refused saves', () => {
  it('bot_name_taken goes back under the name field', () => {
    expect(botSaveFailure('bot_name_taken', 'taken', 'bots.manage.createFailed')).toEqual({
      kind: 'name',
      issue: 'taken',
    });
  });

  it('bot_limit is the 20-Bot rule', () => {
    expect(botSaveFailure('bot_limit', 'Too many Bots', 'bots.manage.createFailed')).toEqual({
      kind: 'alert',
      key: 'bots.manage.limit',
    });
  });

  it('anything else is the save failing, with the server sentence when there is one', () => {
    expect(botSaveFailure('bot_name_invalid', 'Invalid avatar', 'bots.manage.saveFailed')).toEqual({
      kind: 'alert',
      key: 'bots.manage.saveFailed',
      message: 'Invalid avatar',
    });
    expect(botSaveFailure(null, '', 'bots.manage.createFailed')).toEqual({
      kind: 'alert',
      key: 'bots.manage.createFailed',
      message: undefined,
    });
  });

  it('the name line has copy for every issue but "required"', () => {
    expect(nameIssueKey(null)).toBeNull();
    expect(nameIssueKey('required')).toBeNull();
    expect(nameIssueKey('taken')).toBe('bots.manage.nameErr.taken');
    expect(nameIssueKey('is_you')).toBe('bots.manage.nameErr.is_you');
  });
});

describe('✓', () => {
  const initial = botValues(sage);

  it('an edit needs a change; create and accept do not', () => {
    expect(botFormCanSave({ mode: 'edit', initial, values: initial, nameIssue: null })).toBe(false);
    expect(botFormCanSave({ mode: 'edit', initial, values: { ...initial, role: 'X' }, nameIssue: null })).toBe(true);
    expect(botFormCanSave({ mode: 'create', initial, values: initial, nameIssue: null })).toBe(true);
    expect(botFormCanSave({ mode: 'proposal', initial, values: initial, nameIssue: null })).toBe(true);
  });

  it('a name issue or an over-long field blocks it', () => {
    expect(botFormCanSave({ mode: 'create', initial, values: initial, nameIssue: 'taken' })).toBe(false);
    expect(
      botFormCanSave({ mode: 'create', initial, values: { ...initial, role: 'x'.repeat(41) }, nameIssue: null }),
    ).toBe(false);
    expect(botFormDirty(initial, { ...initial, avatar: { ...initial.avatar } })).toBe(false);
  });
});

describe('computer warning', () => {
  const runtime = (state: ComputerRuntimeView['state']): ComputerRuntimeView => ({
    state,
    reason: null,
    hardened: true,
  });

  it('only a computer template, only while the computer is not ready, never for an edit', () => {
    expect(needsComputerWarning({ mode: 'create', templateKey: 'researcher' }, runtime('unavailable'))).toBe(true);
    expect(needsComputerWarning({ mode: 'proposal', templateKey: 'operator' }, runtime('disabled'))).toBe(true);
    expect(needsComputerWarning({ mode: 'create', templateKey: 'researcher' }, runtime('ready'))).toBe(false);
    expect(needsComputerWarning({ mode: 'create', templateKey: 'writer' }, runtime('unavailable'))).toBe(false);
    expect(needsComputerWarning({ mode: 'edit', templateKey: 'researcher' }, runtime('unavailable'))).toBe(false);
    expect(needsComputerWarning({ mode: 'create', templateKey: 'researcher' }, null)).toBe(false);
  });
});
