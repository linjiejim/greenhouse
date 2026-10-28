import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_ROUTES } from '../shared/client-routes';
import {
  captureEntry,
  heldEntryParams,
  isStandaloneEntry,
  markActivated,
  releaseEntryParams,
  takeActivated,
} from './entry-links';

afterEach(() => {
  for (const route of Object.values(CLIENT_ROUTES)) releaseEntryParams(route);
});

describe('entry fragments', () => {
  it('holds an entry route’s fragment back and shows the address without it', () => {
    expect(captureEntry('/activate#token=abc')).toBe('/activate');
    expect(heldEntryParams(CLIENT_ROUTES.activate)?.get('token')).toBe('abc');
    // only its own page sees it
    expect(heldEntryParams(CLIENT_ROUTES.login)).toBeNull();
    releaseEntryParams(CLIENT_ROUTES.activate);
    expect(heldEntryParams(CLIENT_ROUTES.activate)).toBeNull();
  });

  it('keeps the query and reads a connector return and a sign-in return', () => {
    expect(captureEntry('/connectors/oauth-finish#code=c1&state=s1')).toBe('/connectors/oauth-finish');
    expect(Object.fromEntries(heldEntryParams(CLIENT_ROUTES.connectorFinish)!)).toEqual({ code: 'c1', state: 's1' });
    expect(captureEntry('/login?x=1#feishu_code=abc')).toBe('/login?x=1');
    expect(heldEntryParams(CLIENT_ROUTES.login)?.get('feishu_code')).toBe('abc');
  });

  it('leaves every other address alone', () => {
    for (const address of ['/', '/chat?session=s1', '/knowledge#section', '/activate', '/bindings?feishu=ok']) {
      expect(captureEntry(address)).toBe(address);
    }
    expect(heldEntryParams(CLIENT_ROUTES.activate)).toBeNull();
  });

  it('holds the consent request exactly as the browser parsed it, and keeps it in the address', () => {
    const query = 'client_id=c1&scope=mcp%3Aread+mcp%3Afiles&code_challenge=Ab_-9&state=s%2B1';
    expect(captureEntry(`/oauth-consent?${query}`)).toBe(`/oauth-consent?${query}`);
    const held = heldEntryParams(CLIENT_ROUTES.oauthConsent)!;
    expect(held.get('scope')).toBe('mcp:read mcp:files');
    expect(held.get('state')).toBe('s+1');
    expect(held.get('code_challenge')).toBe('Ab_-9');
  });
});

describe('standalone entry pages', () => {
  it('draw without the rail; ordinary places keep it', () => {
    for (const path of ['/activate', '/oauth-consent', '/connectors/oauth-finish', '/bindings'])
      expect(isStandaloneEntry(path)).toBe(true);
    for (const path of ['/', '/login', '/me/connectors', '/chat']) expect(isStandaloneEntry(path)).toBe(false);
  });

  it('an activation hands the root gate one trip home', () => {
    expect(takeActivated()).toBe(false);
    markActivated();
    expect(takeActivated()).toBe(true);
    expect(takeActivated()).toBe(false);
  });
});
