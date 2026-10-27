import { describe, expect, it } from 'vitest';
import { linkTarget, notificationTarget, parseHashRoute, webUrl } from './deep-links';

const BASE = 'https://gh.example';

describe('hash routes', () => {
  it('opens documents and files natively, everything else on the web', () => {
    expect(parseHashRoute('#/knowledge/doc/12-team-handbook')).toEqual({ kind: 'doc', id: '12' });
    expect(parseHashRoute('#/knowledge/doc/12')).toEqual({ kind: 'doc', id: '12' });
    expect(parseHashRoute('#/files?shelf=personal&folder=3&file=9')).toEqual({
      kind: 'files',
      shelf: 'personal',
      folderId: '3',
      fileId: '9',
    });
    expect(parseHashRoute('#/files')).toEqual({ kind: 'files', shelf: 'team', folderId: null, fileId: null });
    expect(parseHashRoute('#/activity/automation/rtr_1')).toEqual({ kind: 'web', hash: '#/activity/automation/rtr_1' });
    expect(parseHashRoute('#/knowledge')).toEqual({ kind: 'web', hash: '#/knowledge' });
    expect(parseHashRoute('/files')).toBeNull();
  });

  it('names a document by slug when its link carries no id', () => {
    expect(parseHashRoute('#/knowledge/doc/incident-response-runbook')).toEqual({
      kind: 'doc',
      slug: 'incident-response-runbook',
    });
    expect(parseHashRoute('#/knowledge/doc/abc')).toEqual({ kind: 'doc', slug: 'abc' });
    expect(parseHashRoute('#/knowledge/doc/%E6%8C%87%E5%8D%97')).toEqual({ kind: 'doc', slug: '指南' });
    expect(parseHashRoute('#/knowledge/doc/01-plan')).toEqual({ kind: 'doc', slug: '01-plan' });
    // the address-bar routes the web shows on a document
    expect(parseHashRoute('#/knowledge/internal/general/api-style-guide')).toEqual({ kind: 'doc', slug: 'api-style-guide' });
    expect(parseHashRoute('#/knowledge/internal/general/api-style-guide/edit')).toEqual({
      kind: 'doc',
      slug: 'api-style-guide',
    });
    expect(parseHashRoute('#/knowledge/personal/my-notes')).toEqual({ kind: 'doc', slug: 'my-notes' });
    expect(parseHashRoute('#/knowledge/shared/their-notes')).toEqual({ kind: 'doc', slug: 'their-notes' });
    expect(parseHashRoute('#/knowledge/folder/5/legacy-slug')).toEqual({ kind: 'doc', slug: 'legacy-slug' });
    expect(linkTarget(`${BASE}/#/knowledge/doc/runbook`, BASE)).toEqual({ kind: 'doc', slug: 'runbook' });
    // lists, folders and broken encodings are not documents
    for (const hash of [
      '#/knowledge/doc/',
      '#/knowledge/internal/general',
      '#/knowledge/personal',
      '#/knowledge/folder/5',
      '#/knowledge/folder/abc/slug',
      '#/knowledge/doc/a/b',
      '#/knowledge/doc/%E6%8C',
    ]) {
      expect(parseHashRoute(hash)).toEqual({ kind: 'web', hash });
    }
  });

  it('reads 3.0 prefixed ULID ids as text', () => {
    const doc = 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0';
    expect(parseHashRoute(`#/knowledge/doc/${doc}-team-handbook`)).toEqual({ kind: 'doc', id: doc });
    expect(parseHashRoute(`#/knowledge/doc/${doc}`)).toEqual({ kind: 'doc', id: doc });
    expect(parseHashRoute('#/projects/prj_01JB2Y8Z9QW3E4R5T6Y7V8H9P0?task=tsk_01JB2Y8Z9QW3E4R5T6Y7V8H9P1')).toEqual({
      kind: 'project',
      id: 'prj_01JB2Y8Z9QW3E4R5T6Y7V8H9P0',
      taskId: 'tsk_01JB2Y8Z9QW3E4R5T6Y7V8H9P1',
    });
    expect(parseHashRoute('#/tables/bas_01JB2Y8Z9QW3E4R5T6Y7V8H9P0/table/7?record=rec_01JB2Y8Z9QW3E4R5T6Y7V8H9P0')).toEqual({
      kind: 'tables',
      baseId: 'bas_01JB2Y8Z9QW3E4R5T6Y7V8H9P0',
      tableId: '7',
      recordId: 'rec_01JB2Y8Z9QW3E4R5T6Y7V8H9P0',
    });
    expect(parseHashRoute('#/files?file=fil_01JB2Y8Z9QW3E4R5T6Y7V8H9P0')).toMatchObject({ fileId: 'fil_01JB2Y8Z9QW3E4R5T6Y7V8H9P0' });
    expect(parseHashRoute('#/files?file=01&folder=fld_bad')).toMatchObject({ fileId: null, folderId: null });
  });
});

describe('C2 routes', () => {
  it('opens projects, tasks, tables, records, conversations and My Agents natively', () => {
    expect(parseHashRoute('#/projects')).toEqual({ kind: 'project', id: null, taskId: null });
    expect(parseHashRoute('#/projects/7')).toEqual({ kind: 'project', id: '7', taskId: null });
    expect(parseHashRoute('#/projects/7?task=12')).toEqual({ kind: 'project', id: '7', taskId: '12' });
    expect(parseHashRoute('#/projects/x')).toEqual({ kind: 'web', hash: '#/projects/x' });
    expect(parseHashRoute('#/tables')).toEqual({ kind: 'tables', baseId: null, tableId: null, recordId: null });
    expect(parseHashRoute('#/tables/3')).toEqual({ kind: 'tables', baseId: '3', tableId: null, recordId: null });
    expect(parseHashRoute('#/tables/3/table/9?record=41')).toEqual({ kind: 'tables', baseId: '3', tableId: '9', recordId: '41' });
    expect(parseHashRoute('#/tables/3/dashboard/2')).toEqual({ kind: 'web', hash: '#/tables/3/dashboard/2' });
    expect(parseHashRoute('#/tables/catalog')).toEqual({ kind: 'web', hash: '#/tables/catalog' });
    expect(parseHashRoute('#/chat?session=ses_9')).toEqual({ kind: 'chat', sessionId: 'ses_9' });
    expect(parseHashRoute('#/settings/agent-connections/activity')).toEqual({ kind: 'agent' });
  });

  it('follows the monthly retro notice to its document', () => {
    expect(
      notificationTarget({ run_id: null, payload: { url: '#/knowledge/doc/42-retro-2026-09', doc_id: '42' } }, BASE),
    ).toEqual({ kind: 'doc', id: '42' });
    expect(notificationTarget({ run_id: null, payload: { url: '#/tables/3/table/9?record=41' } }, BASE)).toEqual({
      kind: 'tables',
      baseId: '3',
      tableId: '9',
      recordId: '41',
    });
  });
});

describe('links in content', () => {
  it('reads same-station links as routes and leaves other sites alone', () => {
    expect(linkTarget(`${BASE}/#/knowledge/doc/5-x`, BASE)).toEqual({ kind: 'doc', id: '5' });
    expect(linkTarget('https://other.example/#/knowledge/doc/5-x', BASE)).toEqual({
      kind: 'external',
      url: 'https://other.example/#/knowledge/doc/5-x',
    });
    expect(linkTarget('#/files?folder=2', BASE)).toMatchObject({ kind: 'files', folderId: '2' });
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
      id: '7',
    });
    expect(notificationTarget({ run_id: null, payload: { url: `${BASE}/#/files?file=4` } }, BASE)).toMatchObject({
      kind: 'files',
      fileId: '4',
    });
  });

  it('opens a scheduled task’s conversation, or the run in the Activity log', () => {
    expect(notificationTarget({ run_id: 'rtr_1', payload: { session_id: 'ses_1' } }, BASE)).toEqual({
      kind: 'chat',
      sessionId: 'ses_1',
    });
    expect(notificationTarget({ run_id: 'rtr_1', payload: { session_id: 's 1' } }, BASE)).toEqual({
      kind: 'chat',
      sessionId: null,
    });
    expect(notificationTarget({ run_id: 'rtr_1', payload: { runtime_kind: 'automation' } }, BASE)).toEqual({
      kind: 'web',
      hash: '#/activity/automation/rtr_1',
    });
    expect(notificationTarget({ run_id: 'rtr_1', payload: { runtime_kind: 'agent_write' } }, BASE)).toEqual({ kind: 'agent' });
    expect(notificationTarget({ run_id: 'rtr_2', payload: {} }, BASE)).toEqual({ kind: 'web', hash: '#/activity/rtr_2' });
    expect(notificationTarget({ run_id: null, payload: { href: 'https://evil.example' } }, BASE)).toBeNull();
  });
});
