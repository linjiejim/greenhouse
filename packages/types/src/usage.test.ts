import { describe, expect, it } from 'vitest';
import { extensionPageModuleId, isPageModuleId, parseAppClient, PAGE_MODULE_IDS } from './usage';

describe('isPageModuleId', () => {
  it('accepts every core module id', () => {
    for (const id of PAGE_MODULE_IDS) expect(isPageModuleId(id, [])).toBe(true);
  });

  it('accepts `ext.<id>` only for an active extension', () => {
    expect(isPageModuleId(extensionPageModuleId('crm'), ['crm'])).toBe(true);
    expect(isPageModuleId('ext.crm', ['example'])).toBe(false);
    expect(isPageModuleId('ext.', [''])).toBe(false);
  });

  it('rejects anything else', () => {
    for (const value of ['', 'design', 'settings', 'admin.unknown', 'CHAT', ' chat', 42, null, undefined, {}]) {
      expect(isPageModuleId(value, ['example'])).toBe(false);
    }
  });
});

describe('parseAppClient', () => {
  it('reads the first-party apps, case-insensitively', () => {
    expect(parseAppClient(' Mobile ')).toBe('mobile');
  });

  it('treats a missing or unknown value as the plain web app', () => {
    expect(parseAppClient(undefined)).toBeNull();
    expect(parseAppClient('')).toBeNull();
    expect(parseAppClient('web')).toBeNull();
    expect(parseAppClient('mcp')).toBeNull();
    // The desktop app and the browser extension were removed in 1.5; their old
    // headers no longer label counts.
    expect(parseAppClient('desktop')).toBeNull();
    expect(parseAppClient('browser')).toBeNull();
  });
});
