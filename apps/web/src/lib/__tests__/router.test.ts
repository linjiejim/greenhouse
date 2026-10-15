import { describe, expect, it } from 'vitest';
import { href, parse, type Route } from '../router';

describe('hash routes', () => {
  it('reads every documented route', () => {
    expect(parse('')).toEqual({ page: 'conversation', id: 'main' });
    expect(parse('#/')).toEqual({ page: 'conversation', id: 'main' });
    expect(parse('#/c/new')).toEqual({ page: 'conversation', id: 'new' });
    expect(parse('#/c/cnv_01')).toEqual({ page: 'conversation', id: 'cnv_01' });
    expect(parse('#/c/new?agent=agt_1')).toEqual({ page: 'conversation', id: 'new', agent: 'agt_1' });
    expect(parse('#/c/cnv_01?agent=agt_1')).toEqual({ page: 'conversation', id: 'cnv_01' });
    expect(parse('#/agents?scope=archived')).toEqual({ page: 'agents', scope: 'archived' });
    expect(parse('#/agents/agt_1?tab=memory')).toEqual({ page: 'agent', id: 'agt_1', tab: 'memory' });
    expect(parse('#/runs?view=done')).toEqual({ page: 'runs', view: 'done' });
    expect(parse('#/runs/run_1')).toEqual({ page: 'run', id: 'run_1' });
    expect(parse('#/notifications')).toEqual({ page: 'notifications' });
    expect(parse('#/notifications?view=all')).toEqual({ page: 'notifications' });
    expect(parse('#/settings/vault')).toEqual({ page: 'settings', section: 'vault' });
    expect(parse('#/admin/public-agents')).toEqual({ page: 'admin', section: 'public-agents' });
    expect(parse('#/activate?token=abc')).toEqual({ page: 'activate', token: 'abc' });
    expect(parse('#/tables')).toEqual({ page: 'tables' });
    expect(parse('#/tables/bas_1')).toEqual({ page: 'base', id: 'bas_1' });
    expect(parse('#/tables/bas_1/tbl_1/viw_1?record=rec_1')).toEqual({
      page: 'base',
      id: 'bas_1',
      table: 'tbl_1',
      view: 'viw_1',
      record: 'rec_1',
    });
    expect(parse('#/tables/bas_1?dashboard=viw_2')).toEqual({ page: 'base', id: 'bas_1', dashboard: 'viw_2' });
    expect(parse('#/forms/frm_1')).toEqual({ page: 'form', id: 'frm_1' });
    expect(parse('#/oauth/consent?request=req_1')).toEqual({ page: 'consent', request: 'req_1', error: '' });
    expect(parse('#/oauth/consent?error=invalid_client')).toEqual({
      page: 'consent',
      request: '',
      error: 'invalid_client',
    });
    expect(parse('#/knowledge')).toEqual({ page: 'knowledge' });
    expect(parse('#/knowledge?space=shared')).toEqual({ page: 'knowledge', space: 'shared' });
    expect(parse('#/knowledge?space=personal&view=archived')).toEqual({
      page: 'knowledge',
      space: 'personal',
      archived: true,
    });
    expect(parse('#/knowledge?space=team&file=fil_1')).toEqual({ page: 'knowledge', space: 'team', file: 'fil_1' });
    expect(parse('#/knowledge/doc_1')).toEqual({ page: 'doc', id: 'doc_1' });
    expect(parse('#/knowledge/doc_1?edit=1')).toEqual({ page: 'doc', id: 'doc_1', edit: true });
    expect(parse('#/knowledge/folder/fld_1')).toEqual({ page: 'folder', id: 'fld_1' });
    expect(parse('#/knowledge/folder/fld_1?file=fil_1')).toEqual({ page: 'folder', id: 'fld_1', file: 'fil_1' });
    // The callback hands a sign-in back to 设置 → 连接; the page reads its own parameters.
    expect(parse('#/settings/connections?oauth_state=s&oauth_code=c')).toEqual({
      page: 'settings',
      section: 'connections',
    });
  });

  it('falls back to a default for unknown values and refuses unknown paths', () => {
    expect(parse('#/agents?scope=everyone')).toEqual({ page: 'agents', scope: 'mine' });
    expect(parse('#/settings/nope')).toEqual({ page: 'settings', section: 'account' });
    expect(parse('#/knowledge?space=everyone')).toEqual({ page: 'knowledge' });
    expect(parse('#/knowledge?space=shared&view=archived')).toEqual({ page: 'knowledge', space: 'shared' });
    expect(parse('#/knowledge/folder')).toEqual({ page: 'not-found', path: '/knowledge/folder' });
    expect(parse('#/knowledge/doc_1/more')).toEqual({ page: 'not-found', path: '/knowledge/doc_1/more' });
    expect(parse('#/knowledge/folder/fld_1/more')).toEqual({
      page: 'not-found',
      path: '/knowledge/folder/fld_1/more',
    });
    expect(parse('#/tables/a/b/c/d')).toEqual({ page: 'not-found', path: '/tables/a/b/c/d' });
    expect(parse('#/c/a/b')).toEqual({ page: 'not-found', path: '/c/a/b' });
    expect(parse('#/c/%E0%A4%A')).toEqual({ page: 'conversation', id: '%E0%A4%A' });
    expect(parse('#/oauth/authorize')).toEqual({ page: 'not-found', path: '/oauth/authorize' });
  });

  it('writes what it reads', () => {
    const routes: Route[] = [
      { page: 'conversation', id: 'main' },
      { page: 'conversation', id: 'cnv 1/2' },
      { page: 'conversation', id: 'new', agent: 'agt_1' },
      { page: 'agents', scope: 'mine' },
      { page: 'agents', scope: 'public' },
      { page: 'agent', id: 'main', tab: 'profile' },
      { page: 'agent', id: 'agt_1', tab: 'computer' },
      { page: 'runs', view: 'active' },
      { page: 'runs', view: 'scheduled' },
      { page: 'run', id: 'run_1' },
      { page: 'knowledge' },
      { page: 'knowledge', space: 'team' },
      { page: 'knowledge', space: 'personal', archived: true },
      { page: 'knowledge', space: 'shared', file: 'fil 1' },
      { page: 'folder', id: 'fld_1' },
      { page: 'folder', id: 'fld/1', file: 'fil_1' },
      { page: 'doc', id: 'doc_1' },
      { page: 'doc', id: 'doc_1', edit: true },
      { page: 'notifications' },
      { page: 'notifications' },
      { page: 'settings', section: 'services' },
      { page: 'admin', section: 'usage' },
      { page: 'activate', token: 'a+b/c' },
      { page: 'consent', request: 'a+b/c', error: '' },
      { page: 'tables' },
      { page: 'base', id: 'bas_1' },
      { page: 'base', id: 'bas_1', table: 'tbl_1' },
      { page: 'base', id: 'bas_1', table: 'tbl_1', view: 'viw_1', record: 'rec_1' },
      { page: 'base', id: 'bas_1', dashboard: 'viw_2' },
      { page: 'form', id: 'frm_1' },
      { page: 'consent', request: '', error: 'invalid_redirect_uri' },
    ];
    for (const route of routes) expect(parse(href(route))).toEqual(route);
  });
});
