import { describe, expect, it } from 'vitest';
import { appLinkTarget, linkTarget, notificationTarget, parseAppPath, parseHashRoute, targetHash, webUrl } from './deep-links';

const BASE = 'https://gh.example';

describe('hash routes', () => {
  it('opens documents and files natively, and leaves other addresses to the manifest', () => {
    expect(parseHashRoute('#/knowledge/doc/12-team-handbook')).toEqual({ kind: 'doc', id: '12' });
    expect(parseHashRoute('#/knowledge/doc/12')).toEqual({ kind: 'doc', id: '12' });
    expect(parseHashRoute('#/files?shelf=personal&folder=3&file=9')).toEqual({
      kind: 'files',
      shelf: 'personal',
      folderId: '3',
      fileId: '9',
    });
    expect(parseHashRoute('#/files')).toEqual({ kind: 'files', shelf: 'team', folderId: null, fileId: null });
    expect(parseHashRoute('#/automations')).toEqual({ kind: 'automations', id: null });
    expect(parseHashRoute('#/automations?tab=profiles')).toEqual({ kind: 'automations', id: null });
    expect(parseHashRoute('#/automations?id=tsk_01JABCDEFGHJKMNPQRSTVWXYZ0')).toEqual({
      kind: 'automations',
      id: 'tsk_01JABCDEFGHJKMNPQRSTVWXYZ0',
    });
    expect(parseHashRoute('#/automations/42')).toEqual({ kind: 'automations', id: '42' });
    expect(parseHashRoute('#/automations?id=nope')).toEqual({ kind: 'automations', id: null });
    expect(parseHashRoute('#/automations/nope')).toEqual({ kind: 'route', hash: '#/automations/nope' });
    expect(parseHashRoute('#/automationsx')).toEqual({ kind: 'route', hash: '#/automationsx' });
    expect(parseHashRoute('#/crm/companies/42')).toEqual({ kind: 'route', hash: '#/crm/companies/42' });
    // classic page routes name nothing
    expect(parseHashRoute('#/activity/automation/rtr_1')).toEqual({ kind: 'route', hash: '#/activity/automation/rtr_1' });
    expect(parseHashRoute('#/knowledge')).toEqual({ kind: 'knowledge' });
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
    expect(linkTarget(`${BASE}/#/knowledge/doc/runbook`, BASE)).toEqual({ kind: 'doc', slug: 'runbook' });
    // lists, folders, the classic address-bar routes and broken encodings are not documents
    for (const hash of [
      '#/knowledge/doc/',
      '#/knowledge/internal/general/api-style-guide',
      '#/knowledge/personal/my-notes',
      '#/knowledge/folder/5/legacy-slug',
      '#/knowledge/internal/general',
      '#/knowledge/personal',
      '#/knowledge/folder/5',
      '#/knowledge/folder/abc/slug',
      '#/knowledge/doc/a/b',
      '#/knowledge/doc/%E6%8C',
    ]) {
      expect(parseHashRoute(hash)).toEqual({ kind: 'route', hash });
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
    expect(parseHashRoute('#/projects/x')).toEqual({ kind: 'route', hash: '#/projects/x' });
    expect(parseHashRoute('#/tables')).toEqual({ kind: 'tables', baseId: null, tableId: null, recordId: null });
    expect(parseHashRoute('#/tables/3')).toEqual({ kind: 'tables', baseId: '3', tableId: null, recordId: null });
    expect(parseHashRoute('#/tables/3/table/9?record=41')).toEqual({ kind: 'tables', baseId: '3', tableId: '9', recordId: '41' });
    expect(parseHashRoute('#/tables/3/dashboard/2')).toEqual({ kind: 'route', hash: '#/tables/3/dashboard/2' });
    expect(parseHashRoute('#/tables/catalog')).toEqual({ kind: 'route', hash: '#/tables/catalog' });
    expect(parseHashRoute('#/chat?session=ses_9')).toEqual({ kind: 'chat', sessionId: 'ses_9' });
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

  it('reads the station’s plugin page links as client pages', () => {
    expect(linkTarget('/p/reports/reports', BASE)).toEqual({ kind: 'page', href: '/p/reports/reports' });
    expect(linkTarget(`${BASE}/p/skills/skills?x=1`, BASE)).toEqual({ kind: 'page', href: '/p/skills/skills?x=1' });
    expect(linkTarget('https://other.example/p/skills/skills', BASE)).toMatchObject({ kind: 'external' });
    expect(linkTarget('/p/../../api/x', BASE)).toBeNull();
    // a station address with no screen here opens the browser client
    expect(linkTarget('/activate?token=x', BASE)).toEqual({ kind: 'external', url: `${BASE}/activate?token=x` });
  });

  it('builds absolute addresses on the station', () => {
    expect(webUrl(`${BASE}/`, '#/projects/7')).toBe(`${BASE}/#/projects/7`);
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

  it('opens a scheduled task’s conversation, or the run', () => {
    expect(notificationTarget({ run_id: 'rtr_1', payload: { session_id: 'ses_1' } }, BASE)).toEqual({
      kind: 'chat',
      sessionId: 'ses_1',
    });
    expect(notificationTarget({ run_id: 'rtr_1', payload: { session_id: 's 1' } }, BASE)).toEqual({
      kind: 'chat',
      sessionId: null,
    });
    expect(notificationTarget({ run_id: 'rtr_1', payload: { runtime_kind: 'automation' } }, BASE)).toEqual({
      kind: 'run',
      id: 'rtr_1',
    });
    expect(notificationTarget({ run_id: 'rtr_1', payload: { runtime_kind: 'agent_write' } }, BASE)).toEqual({ kind: 'agent' });
    expect(notificationTarget({ run_id: 'rtr_2', payload: {} }, BASE)).toEqual({ kind: 'run', id: 'rtr_2' });
    expect(notificationTarget({ run_id: null, payload: { href: 'https://evil.example' } }, BASE)).toBeNull();
  });
});

describe('the browser client’s own addresses', () => {
  const B = 'bas_01M6Q8GKSSB48CA6NBM5GCM4BW';
  const T = 'tbl_01M6Q8GKWCSV0PP19PDMD5S1PF';
  const R = 'rec_01M6Q8H65P3DHGTX3M257TV23G';

  it('opens place addresses as the objects they name', () => {
    expect(parseAppPath(`/drive?view=tables&base=${B}&table=${T}&record=${R}`)).toEqual({
      kind: 'tables',
      baseId: B,
      tableId: T,
      recordId: R,
    });
    expect(parseAppPath(`/drive?view=tables&base=${B}`)).toEqual({ kind: 'tables', baseId: B, tableId: null, recordId: null });
    expect(parseAppPath('/drive?view=tables')).toEqual({ kind: 'tables', baseId: null, tableId: null, recordId: null });
    expect(parseAppPath('/drive?shelf=personal&folder=3')).toEqual({ kind: 'files', shelf: 'personal', folderId: '3', fileId: null });
    expect(parseAppPath(`/drive/table?base=${B}&id=${T}`)).toEqual({ kind: 'tables', baseId: B, tableId: T, recordId: null });
    expect(parseAppPath('/knowledge?doc=12')).toEqual({ kind: 'doc', id: '12' });
    expect(parseAppPath('/knowledge?shelf=team')).toEqual({ kind: 'knowledge' });
    expect(parseAppPath('/projects?project=7&task=9')).toEqual({ kind: 'project', id: '7', taskId: '9' });
    expect(parseAppPath('/projects')).toEqual({ kind: 'project', id: null, taskId: null });
    expect(parseAppPath('/automations?id=4')).toEqual({ kind: 'automations', id: '4' });
    expect(parseAppPath('/chat?session=ses_9')).toEqual({ kind: 'chat', sessionId: 'ses_9' });
    expect(parseAppPath('/')).toEqual({ kind: 'chat', sessionId: null });
    expect(parseAppPath('/me/agents')).toEqual({ kind: 'agent' });
    expect(parseAppPath('/me/connectors')).toEqual({ kind: 'page', href: '/me/connectors' });
    expect(parseAppPath('/admin/users')).toEqual({ kind: 'page', href: '/admin/users' });
  });

  it('opens the sheets of the address bar', () => {
    expect(parseAppPath('/sheet/doc?id=12')).toEqual({ kind: 'doc', id: '12' });
    expect(parseAppPath('/sheet/doc?slug=runbook')).toEqual({ kind: 'doc', slug: 'runbook' });
    expect(parseAppPath('/sheet/task?project=7&id=9')).toEqual({ kind: 'project', id: '7', taskId: '9' });
    expect(parseAppPath(`/sheet/record?base=${B}&table=${T}&id=${R}`)).toEqual({ kind: 'tables', baseId: B, tableId: T, recordId: R });
    expect(parseAppPath('/sheet/file?id=9')).toMatchObject({ kind: 'files', fileId: '9' });
    expect(parseAppPath('/sheet/run?id=run_1')).toEqual({ kind: 'run', id: 'run_1' });
    expect(parseAppPath('/sheet/conversation?session=ses_9')).toEqual({ kind: 'chat', sessionId: 'ses_9' });
    expect(parseAppPath('/sheet/doc')).toBeNull();
    expect(parseAppPath('/sheet/plugin?plugin=x')).toBeNull();
  });

  it('keeps what the address says beyond an object id', () => {
    expect(parseAppPath('/sheet/folder?id=3&scope=kb&shelf=personal')).toEqual({ kind: 'kb-folder', shelf: 'personal', id: '3' });
    expect(parseAppPath('/sheet/folder?id=3&scope=drive&shelf=team')).toEqual({ kind: 'files', shelf: 'team', folderId: '3', fileId: null });
    expect(parseAppPath('/chat?draft=hello&agent=foo')).toEqual({ kind: 'page', href: '/chat?draft=hello&agent=foo' });
    expect(parseAppPath('/chat?session=ses_9&draft=hi')).toEqual({ kind: 'page', href: '/chat?session=ses_9&draft=hi' });
    expect(parseAppPath('/automations?view=agents&id=7')).toEqual({ kind: 'page', href: '/automations?view=agents&id=7' });
    expect(parseAppPath(`/drive/base?id=${B}&table=${T}`)).toEqual({ kind: 'tables', baseId: B, tableId: T, recordId: null });
    expect(parseAppPath('/admin/users?role=team&status=disabled')).toEqual({
      kind: 'page',
      href: '/admin/users?role=team&status=disabled',
    });
  });

  it('names nothing for paths it has no screen for, or that climb out', () => {
    expect(parseAppPath('/activate')).toBeNull();
    expect(parseAppPath('/api/upload/3')).toBeNull();
    expect(parseAppPath('/drive/../api/x')).toBeNull();
    expect(parseAppPath('//evil.example/x')).toBeNull();
    expect(parseAppPath('knowledge')).toBeNull();
  });

  it('reads them relative, absolute on the station, behind /#/ and as app links', () => {
    expect(linkTarget(`/drive?view=tables&base=${B}&table=${T}`, BASE)).toMatchObject({ kind: 'tables', tableId: T });
    expect(linkTarget(`${BASE}/chat?session=ses_9`, BASE)).toEqual({ kind: 'chat', sessionId: 'ses_9' });
    expect(linkTarget(`${BASE}/knowledge?doc=12`, BASE)).toEqual({ kind: 'doc', id: '12' });
    expect(linkTarget('https://other.example/knowledge?doc=12', BASE)).toMatchObject({ kind: 'external' });
    expect(linkTarget('/#/projects/7', BASE)).toEqual({ kind: 'project', id: '7', taskId: null });
    expect(linkTarget('greenhouse://knowledge/doc?id=12', BASE)).toEqual({ kind: 'doc', id: '12' });
    expect(linkTarget('//evil.example/x', BASE)).toBeNull();
  });

  it('reads the app link routes the station writes', () => {
    expect(appLinkTarget('greenhouse://projects/task?project=7&task=9')).toEqual({ kind: 'project', id: '7', taskId: '9' });
    expect(appLinkTarget('greenhouse://projects/detail?id=7')).toEqual({ kind: 'project', id: '7', taskId: null });
    expect(appLinkTarget(`greenhouse://tables/record?table=${T}&record=${R}`)).toEqual({
      kind: 'tables',
      baseId: null,
      tableId: T,
      recordId: R,
    });
    expect(appLinkTarget('greenhouse://chat?session=ses_9')).toEqual({ kind: 'chat', sessionId: 'ses_9' });
    expect(appLinkTarget('greenhouse://files?file=9')).toMatchObject({ kind: 'files', fileId: '9' });
    expect(appLinkTarget('greenhouse://file-preview?id=9')).toMatchObject({ kind: 'files', fileId: '9' });
    // resources and routes with nothing to open stay unopenable
    expect(appLinkTarget('greenhouse://context/team')).toBeNull();
    expect(appLinkTarget('greenhouse://expo-development-client/?url=x')).toBeNull();
    expect(appLinkTarget('greenhouse://connectors/oauth-finish?code=1')).toBeNull();
  });

  it('gives each object its station address, however the link spelled it', () => {
    expect(targetHash({ kind: 'tables', baseId: B, tableId: T, recordId: R })).toBe(`#/tables/${B}/table/${T}?record=${R}`);
    expect(targetHash({ kind: 'tables', baseId: null, tableId: T, recordId: null })).toBeNull();
    expect(targetHash({ kind: 'doc', id: '12' })).toBe('#/knowledge/doc/12');
    expect(targetHash({ kind: 'doc', slug: '指南' })).toBe('#/knowledge/doc/%E6%8C%87%E5%8D%97');
    expect(targetHash({ kind: 'project', id: '7', taskId: '9' })).toBe('#/projects/7?task=9');
    expect(targetHash({ kind: 'knowledge' })).toBeNull();
  });
});
