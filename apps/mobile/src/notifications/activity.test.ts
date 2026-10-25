import { describe, expect, it } from 'vitest';
import type { ActivityItem } from '../shared/greenhouse-types';
import { activityLine, activityOpening, activityTitle } from './activity';

const item = (over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: 'a1',
  source: 'person',
  at: '2026-10-26T08:00:00.000Z',
  actor: { id: 'u1', name: 'Ann' },
  agent: null,
  module: 'projects',
  verb: 'update',
  entity: 'task',
  action: 'updateTask',
  action_title: 'Update task',
  target: { id: '7', label: 'Ship v3', url: '#/projects/3?task=7' },
  run: null,
  detail: null,
  ...over,
});

const words = { verb: (v: string) => ({ update: 'updated', create: 'created' })[v] ?? null, someone: 'Someone' };

describe('team activity rows', () => {
  it('opens the object route, a run sheet for runs, nothing when unnamed', () => {
    expect(activityOpening(item())).toEqual({ href: '#/projects/3?task=7' });
    expect(activityOpening(item({ run: { id: 'rtm_1', kind: 'agent_write' } }))).toEqual({ ref: { kind: 'run', id: 'rtm_1' } });
    expect(activityOpening(item({ target: null }))).toBeNull();
  });

  it('titles by the object, then the action', () => {
    expect(activityTitle(item())).toBe('Ship v3');
    expect(activityTitle(item({ target: { id: '9', label: null, url: null } }))).toBe('#9');
    expect(activityTitle(item({ target: null }))).toBe('Update task');
    expect(activityTitle(item({ target: null, action_title: null }))).toBe('updateTask');
  });

  it('says who did it, through which agent, and the verb', () => {
    expect(activityLine(item(), words)).toBe('Ann updated');
    expect(activityLine(item({ agent: { client_id: null, client_name: 'Codex' } }), words)).toBe('Ann (Codex) updated');
    expect(activityLine(item({ actor: { id: 'u2', name: null }, verb: 'other' }), words)).toBe('Someone');
  });
});
