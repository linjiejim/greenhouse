import { describe, expect, it } from 'vitest';
import { MAX_SHEETS, openingOf, refOfTarget, sheetDepth, sheetMove } from './object-ref';

const routes = (...names: string[]) => names.map((name) => ({ name }));

describe('openObject', () => {
  it('opens every object but a conversation as a sheet', () => {
    expect(openingOf({ kind: 'doc', id: '7' })).toEqual({ via: 'sheet', pathname: '/sheet/doc', params: { id: '7' } });
    expect(openingOf({ kind: 'doc', slug: 'incident-response-runbook' })).toEqual({
      via: 'sheet',
      pathname: '/sheet/doc',
      params: { slug: 'incident-response-runbook' },
    });
    expect(refOfTarget({ kind: 'doc', slug: 'runbook' })).toEqual({ ref: { kind: 'doc', slug: 'runbook' } });
    expect(refOfTarget({ kind: 'doc', id: '7' })).toEqual({ ref: { kind: 'doc', id: '7' } });
    expect(openingOf({ kind: 'task', projectId: '2', id: '9' })).toEqual({
      via: 'sheet',
      pathname: '/sheet/task',
      params: { project: '2', id: '9' },
    });
    expect(openingOf({ kind: 'record', baseId: null, tableId: '3', id: '4' }).params).toEqual({ table: '3', id: '4' });
    expect(openingOf({ kind: 'automation', id: '5' })).toEqual({
      via: 'sheet',
      pathname: '/sheet/automation',
      params: { id: '5' },
    });
    expect(openingOf({ kind: 'folder', scope: 'kb', shelf: 'team', id: '5' }).params).toEqual({
      id: '5',
      scope: 'kb',
      shelf: 'team',
    });
    expect(openingOf({ kind: 'chat', sessionId: 's1' })).toEqual({
      via: 'page',
      pathname: '/chat',
      params: { session: 's1' },
    });
  });

  it('counts only the object sheets at the top of the stack', () => {
    expect(sheetDepth(routes('(drawer)'))).toBe(0);
    expect(sheetDepth(routes('(drawer)', 'sheet/project', 'sheet/task'))).toBe(2);
    expect(sheetDepth(routes('(drawer)', 'sheet/doc', 'chat'))).toBe(0);
    expect(sheetDepth(routes('(drawer)', 'notifications', 'sheet/doc'))).toBe(1);
  });

  it('stacks up to three sheets, then replaces the top one', () => {
    expect(MAX_SHEETS).toBe(3);
    expect([0, 1, 2].map(sheetMove)).toEqual(['push', 'push', 'push']);
    expect(sheetMove(3)).toBe('replace');
  });

  it('turns link targets into objects or places', () => {
    expect(refOfTarget({ kind: 'files', shelf: 'team', folderId: null, fileId: '4' })).toEqual({
      ref: { kind: 'file', id: '4' },
    });
    expect(refOfTarget({ kind: 'files', shelf: 'personal', folderId: '2', fileId: null })).toEqual({
      place: { kind: 'drive', shelf: 'personal', folderId: '2' },
    });
    expect(refOfTarget({ kind: 'project', id: '1', taskId: '8' })).toEqual({
      ref: { kind: 'task', projectId: '1', id: '8' },
    });
    expect(refOfTarget({ kind: 'tables', baseId: '1', tableId: '2', recordId: null })).toEqual({
      place: { kind: 'tables', baseId: '1', tableId: '2' },
    });
    expect(refOfTarget({ kind: 'chat', sessionId: 'abc' })).toEqual({ ref: { kind: 'chat', sessionId: 'abc' } });
    expect(refOfTarget({ kind: 'route', hash: '#/x' })).toEqual({ place: { kind: 'route', hash: '#/x' } });
    expect(refOfTarget({ kind: 'run', id: 'run_1' })).toEqual({ ref: { kind: 'run', id: 'run_1' } });
    expect(refOfTarget({ kind: 'automations', id: null })).toEqual({ place: { kind: 'tab', href: '/automations' } });
    expect(refOfTarget({ kind: 'automations', id: '7' })).toEqual({ ref: { kind: 'automation', id: '7' } });
  });
});

it('opens explicit conversation previews and tool steps in the bounded object stack', () => {
  expect(openingOf({ kind: 'chat-preview', sessionId: 'ses_1' })).toEqual({
    via: 'sheet',
    pathname: '/sheet/conversation',
    params: { session: 'ses_1' },
  });
  expect(openingOf({ kind: 'steps' })).toEqual({ via: 'sheet', pathname: '/sheet/steps', params: {} });
  expect(sheetDepth(routes('(drawer)', 'sheet/conversation', 'sheet/doc', 'sheet/steps'))).toBe(3);
});
