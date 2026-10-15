import { describe, expect, it } from 'vitest';
import type { NeedsYou } from '../shared/contract';
import { cardActions, cardBody, checkAnswers, requestStatus, secondsLeft, standingScope } from './model';

function card(partial: Partial<NeedsYou> = {}): NeedsYou {
  return {
    id: 'req_1',
    kind: 'approval',
    subject: 'tool_write',
    status: 'pending',
    conversation_id: 'c1',
    run_id: null,
    agent_id: 'greeny',
    title: 'Send the weekly email',
    payload: {},
    result: null,
    expires_at: null,
    decided_at: null,
    created_at: '2026-10-14T06:00:00.000Z',
    ...partial,
  };
}

describe('status words (content.md: yellow only while it needs you)', () => {
  it('names every state', () => {
    expect(requestStatus({ status: 'pending' })).toEqual({ word: 'needsYou', tone: 'warning' });
    expect(requestStatus({ status: 'answered' })).toEqual({ word: 'done', tone: 'success' });
    expect(requestStatus({ status: 'handed_back' })).toEqual({ word: 'handedBack', tone: 'success' });
    expect(requestStatus({ status: 'expired' }).tone).toBe('neutral');
  });
});

describe('what a card can do', () => {
  it('per kind, primary last, and nothing once decided', () => {
    expect(cardActions(card(), true)).toEqual(['reject', 'approve']);
    expect(cardActions(card({ kind: 'question', subject: 'ask_user' }), true)).toEqual(['reject', 'answer']);
    expect(cardActions(card({ kind: 'proposal', subject: 'run_start' }), true)).toEqual(['reject', 'approve']);
    expect(cardActions(card({ kind: 'login', subject: 'vault_fill' }), true)).toEqual([
      'reject',
      'signInMyself',
      'approve',
    ]);
    expect(cardActions(card({ kind: 'login', subject: 'vault_fill' }), false)).toEqual(['reject', 'approve']);
    expect(cardActions(card({ kind: 'takeover', subject: 'computer_takeover' }), true)).toEqual([
      'handBack',
      'takeOver',
    ]);
    expect(cardActions(card({ kind: 'takeover', subject: 'computer_takeover' }), false)).toEqual(['handBack']);
    expect(cardActions(card({ status: 'approved' }), true)).toEqual([]);
  });
});

describe('what a card says', () => {
  it('renders ordered tier details and only offers standing approval for tier2 folder/table scopes', () => {
    const payload = {
      tier: 'tier2',
      standing_scope: { type: 'folder', id: 'f1', actions: ['create'] },
      details: [{ label: 'Folder', value: 'Shared notes' }],
    };
    expect(cardBody(card({ payload })).details).toEqual([{ label: 'Folder', value: 'Shared notes' }]);
    expect(standingScope(card({ payload }))).toBe('folder');
    expect(standingScope(card({ payload: { ...payload, tier: 'tier3' } }))).toBeNull();
    expect(standingScope(card({ payload: { ...payload, standing_scope: { type: 'workspace' } } }))).toBeNull();
    expect(standingScope(card({ kind: 'proposal', payload }))).toBeNull();
  });
  it('an approval lists what it would do', () => {
    const body = cardBody(
      card({ payload: { tool: 'send_email', details: { to: 'team@example.com', subject: 'Weekly' } } }),
    );
    expect(body.details).toEqual([
      { label: 'to', value: 'team@example.com' },
      { label: 'subject', value: 'Weekly' },
    ]);
  });

  it('a proposal shows its text under the right heading', () => {
    expect(
      cardBody(
        card({
          kind: 'proposal',
          subject: 'instructions_update',
          payload: { instructions: 'Be brief.', reason: 'You asked' },
        }),
      ),
    ).toMatchObject({ reason: 'You asked', body: 'Be brief.', bodyLabel: 'instructions' });
    expect(
      cardBody(
        card({
          kind: 'proposal',
          subject: 'run_start',
          payload: { run_title: 'Audit links', brief: 'Check every page.' },
        }),
      ),
    ).toMatchObject({
      details: [{ label: 'run', value: 'Audit links' }],
      body: 'Check every page.',
      bodyLabel: 'brief',
    });
    expect(
      cardBody(
        card({ kind: 'proposal', subject: 'skill_save', payload: { skill: { name: 'weekly', body: 'Steps…' } } }),
      ),
    ).toMatchObject({ details: [{ label: 'skill', value: '/weekly' }], body: 'Steps…', bodyLabel: 'skill' });
  });

  it('a sign-in names the site and the saved login, a question its form', () => {
    expect(
      cardBody(
        card({
          kind: 'login',
          subject: 'vault_fill',
          payload: { site: 'github.com', item_label: 'GitHub', username_hint: 'j***' },
        }),
      ).details,
    ).toEqual([
      { label: 'site', value: 'github.com' },
      { label: 'item', value: 'GitHub · j***' },
    ]);
    const fields = [{ key: 'city', label: 'City', type: 'text' as const, required: true }];
    expect(
      cardBody(card({ kind: 'question', subject: 'ask_user', payload: { question: 'Where?', fields } })).fields,
    ).toEqual(fields);
  });
});

describe('answers and deadlines', () => {
  it('sends trimmed answers once every required field is filled', () => {
    const fields = [
      { key: 'city', label: 'City', type: 'text' as const, required: true },
      { key: 'note', label: 'Note', type: 'text' as const, required: false },
    ];
    expect(checkAnswers(fields, { city: '  ' })).toEqual({ ok: false, missing: 'City' });
    expect(checkAnswers(fields, { city: ' Shanghai ', note: '' })).toEqual({ ok: true, answers: { city: 'Shanghai' } });
  });

  it('counts down only in the last minute of a pending card', () => {
    const now = Date.parse('2026-10-14T06:00:00.000Z');
    expect(secondsLeft(card({ expires_at: '2026-10-14T06:00:42.000Z' }), now)).toBe(42);
    expect(secondsLeft(card({ expires_at: '2026-10-14T06:05:00.000Z' }), now)).toBeNull();
    expect(secondsLeft(card({ expires_at: '2026-10-14T06:00:42.000Z', status: 'approved' }), now)).toBeNull();
  });
});
