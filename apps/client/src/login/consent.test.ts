import { describe, expect, it } from 'vitest';
import { en } from '../lib/i18n/en';
import { zh } from '../lib/i18n/zh';
import {
  actionScopes,
  CORE_GROUPS,
  followsRequest,
  grantedScopes,
  offeredGroups,
  redirectHost,
} from './consent';

const plugins = [
  { name: 'Knowledge', description: null, mcp_groups: ['knowledge'], nav: [{ label: { en: 'Knowledge', zh: '知识库' } }] },
  { name: 'Tables', description: 'Bases', mcp_groups: ['tables'] },
];

describe('what a consent offers', () => {
  it('lists the requested core groups, then the requested plugin groups; never retired or unknown ones', () => {
    const scopes = ['mcp:read', 'mcp:write', 'mcp:files', 'mcp:image', 'mcp:knowledge', 'mcp:crm', 'mcp:chat'];
    const offered = offeredGroups(scopes, plugins);
    expect(offered.map((group) => group.scope)).toEqual(['mcp:files', 'mcp:chat', 'mcp:knowledge']);
    // a plugin's group goes by the app's rail name
    expect(offered[2]).toMatchObject({ plugin: { name: { en: 'Knowledge', zh: '知识库' } } });
    expect(actionScopes(scopes)).toEqual(['mcp:read', 'mcp:write']);
  });

  it('grants the verbs and the ticked groups, nothing it did not offer', () => {
    const scopes = ['mcp:read', 'mcp:files', 'mcp:chat', 'mcp:crm'];
    const offered = offeredGroups(scopes, plugins);
    expect(grantedScopes(scopes, offered, new Set(['mcp:chat', 'mcp:crm']))).toEqual(['mcp:read', 'mcp:chat']);
    expect(grantedScopes(scopes, offered, new Set())).toEqual(['mcp:read']);
  });

  it('names every core group in both languages', () => {
    for (const id of CORE_GROUPS) {
      for (const catalog of [en, zh]) {
        expect(catalog.entry.groups[id].label, id).toBeTruthy();
        expect(catalog.entry.groups[id].description, id).toBeTruthy();
      }
    }
  });
});

describe('where a decision returns', () => {
  const request = { redirect_uri: 'http://127.0.0.1:8123/callback', state: 'state-12345678' };

  it('shows the host, or the scheme of an app address', () => {
    expect(redirectHost('https://claude.ai/api/mcp/auth_callback')).toBe('claude.ai');
    expect(redirectHost(request.redirect_uri)).toBe('127.0.0.1:8123');
    expect(redirectHost('cursor://anysphere.cursor-mcp/oauth/callback')).toBe('anysphere.cursor-mcp');
  });

  it('follows only an answer to the request’s own address with its own state', () => {
    expect(followsRequest('http://127.0.0.1:8123/callback?code=c&state=state-12345678', request)).toBe(true);
    expect(followsRequest('http://127.0.0.1:8123/callback?error=access_denied&state=state-12345678', request)).toBe(true);
    expect(followsRequest('http://127.0.0.1:8123/callback?code=c&state=other', request)).toBe(false);
    expect(followsRequest('https://evil.example/callback?code=c&state=state-12345678', request)).toBe(false);
    expect(followsRequest('http://127.0.0.1:8123/elsewhere?code=c&state=state-12345678', request)).toBe(false);
    expect(followsRequest('not a url', request)).toBe(false);
  });
});
