import { describe, expect, it } from 'vitest';
import { linkTarget, notificationTarget, parseHashRoute, webUrl } from './deep-links';

const BASE = 'https://gh.example';

describe('hash routes', () => {
  it('opens documents and files natively, everything else on the web', () => {
    expect(parseHashRoute('#/knowledge/doc/12-team-handbook')).toEqual({ kind: 'doc', id: 12 });
    expect(parseHashRoute('#/knowledge/doc/12')).toEqual({ kind: 'doc', id: 12 });
    expect(parseHashRoute('#/files?shelf=personal&folder=3&file=9')).toEqual({
      kind: 'files',
      shelf: 'personal',
      folderId: 3,
      fileId: 9,
    });
    expect(parseHashRoute('#/files')).toEqual({ kind: 'files', shelf: 'team', folderId: null, fileId: null });
    expect(parseHashRoute('#/activity/automation/rtr_1')).toEqual({ kind: 'web', hash: '#/activity/automation/rtr_1' });
    expect(parseHashRoute('#/knowledge/doc/abc')).toEqual({ kind: 'web', hash: '#/knowledge/doc/abc' });
    expect(parseHashRoute('/files')).toBeNull();
  });
});

describe('links in content', () => {
  it('reads same-station links as routes and leaves other sites alone', () => {
    expect(linkTarget(`${BASE}/#/knowledge/doc/5-x`, BASE)).toEqual({ kind: 'doc', id: 5 });
    expect(linkTarget('https://other.example/#/knowledge/doc/5-x', BASE)).toEqual({
      kind: 'external',
      url: 'https://other.example/#/knowledge/doc/5-x',
    });
    expect(linkTarget('#/files?folder=2', BASE)).toMatchObject({ kind: 'files', folderId: 2 });
    expect(linkTarget('javascript:alert(1)', BASE)).toBeNull();
    expect(linkTarget('relative/path', BASE)).toBeNull();
  });

  it('builds web addresses on the station', () => {
    expect(webUrl(`${BASE}/`, '#/activity/x')).toBe(`${BASE}/#/activity/x`);
  });
});

describe('notifications', () => {
  it('follows a link the payload names first', () => {
    expect(notificationTarget({ run_id: 'rtr_1', payload: { href: '#/knowledge/doc/7-x' } }, BASE)).toEqual({
      kind: 'doc',
      id: 7,
    });
    expect(notificationTarget({ run_id: null, payload: { url: `${BASE}/#/files?file=4` } }, BASE)).toMatchObject({
      kind: 'files',
      fileId: 4,
    });
  });

  it('opens a scheduled task’s conversation, or the run in the Activity log', () => {
    expect(notificationTarget({ run_id: 'rtr_1', payload: { session_id: 's 1' } }, BASE)).toEqual({
      kind: 'web',
      hash: '#/chat?session=s%201',
    });
    expect(notificationTarget({ run_id: 'rtr_1', payload: { runtime_kind: 'automation' } }, BASE)).toEqual({
      kind: 'web',
      hash: '#/activity/automation/rtr_1',
    });
    expect(notificationTarget({ run_id: 'rtr_1', payload: { runtime_kind: 'agent_write' } }, BASE)).toEqual({
      kind: 'web',
      hash: '#/settings/agent-connections/activity',
    });
    expect(notificationTarget({ run_id: 'rtr_2', payload: {} }, BASE)).toEqual({ kind: 'web', hash: '#/activity/rtr_2' });
    expect(notificationTarget({ run_id: null, payload: { href: 'https://evil.example' } }, BASE)).toBeNull();
  });
});
