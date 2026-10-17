/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_VERSION } from '@greenhouse/contract';
import { checkServer, finishServerSwitch, isFirstLaunch, parseServerAddress, switchServer } from '../server';

function shell(answers: Record<string, unknown> = {}, base = 'http://localhost:3000') {
  const invoke = vi.fn(async (command: string) => {
    const answer = answers[command];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  window.__TAURI_INTERNALS__ = { invoke };
  window.__GREENHOUSE_DESKTOP_API_BASE__ = base;
  return invoke;
}

const respond = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

beforeEach(() => localStorage.clear());
afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  delete window.__GREENHOUSE_DESKTOP_API_BASE__;
});

describe('server address', () => {
  it('takes a bare origin and adds https when the scheme is missing', () => {
    expect(parseServerAddress(' https://green.example.com/ ')).toEqual({
      ok: true,
      origin: 'https://green.example.com',
    });
    expect(parseServerAddress('green.example.com:8443')).toEqual({
      ok: true,
      origin: 'https://green.example.com:8443',
    });
    expect(parseServerAddress('HTTPS://Green.Example.com:443')).toEqual({
      ok: true,
      origin: 'https://green.example.com',
    });
  });

  it('allows plain http only for this computer', () => {
    expect(parseServerAddress('http://localhost:3101')).toEqual({ ok: true, origin: 'http://localhost:3101' });
    expect(parseServerAddress('localhost:3000')).toEqual({ ok: true, origin: 'http://localhost:3000' });
    expect(parseServerAddress('http://127.0.0.1:3000')).toEqual({ ok: true, origin: 'http://127.0.0.1:3000' });
    expect(parseServerAddress('http://192.168.1.20:3000')).toEqual({ ok: false, error: 'insecure' });
    expect(parseServerAddress('http://green.example.com')).toEqual({ ok: false, error: 'insecure' });
  });

  it('refuses anything that is not a bare http(s) origin', () => {
    for (const raw of [
      '',
      '   ',
      'ftp://example.com',
      'javascript:alert(1)',
      'https://example.com/base',
      'https://example.com?a=1',
      'https://example.com#x',
      'https://user:pass@example.com',
      'https://exa mple.com',
    ])
      expect(parseServerAddress(raw), raw).toEqual({ ok: false, error: 'invalid' });
  });
});

describe('server check', () => {
  it('accepts a server that speaks this API or a newer one', async () => {
    const send = respond({ api_version: API_VERSION, name: 'Green' });
    expect(await checkServer('https://green.example.com', send)).toEqual({ ok: true, name: 'Green' });
    expect(send).toHaveBeenCalledWith('https://green.example.com/api/bootstrap', expect.anything());
    expect(await checkServer('https://x', respond({ api_version: API_VERSION + 1, name: 'Next' }))).toEqual({
      ok: true,
      name: 'Next',
    });
  });

  it('says why a server cannot be used', async () => {
    const offline = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await checkServer('https://x', offline)).toEqual({ ok: false, error: 'unreachable' });
    expect(await checkServer('https://x', respond('not found', 404))).toEqual({ ok: false, error: 'not_greenhouse' });
    expect(await checkServer('https://x', respond('<html></html>'))).toEqual({ ok: false, error: 'not_greenhouse' });
    expect(await checkServer('https://x', respond({ name: 'Other' }))).toEqual({ ok: false, error: 'not_greenhouse' });
    expect(await checkServer('https://x', respond({ api_version: API_VERSION - 1 }))).toEqual({
      ok: false,
      error: 'too_old',
    });
  });
});

describe('first launch', () => {
  const unlocked = { apiBaseUrl: 'http://localhost:3000', apiBaseLocked: false };

  it('asks an unlocked app on the dev default until a server is chosen', async () => {
    expect(isFirstLaunch(unlocked)).toBe(true);
    shell({ desktop_set_api_base: unlocked });
    await switchServer('http://localhost:3000');
    expect(isFirstLaunch(unlocked)).toBe(false);
  });

  it('never asks a locked app or one already pointed elsewhere', () => {
    expect(isFirstLaunch({ apiBaseUrl: 'http://localhost:3000', apiBaseLocked: true })).toBe(false);
    expect(isFirstLaunch({ apiBaseUrl: 'https://green.example.com', apiBaseLocked: false })).toBe(false);
  });
});

describe('switching servers', () => {
  it('saves the address and restarts the app', async () => {
    const invoke = shell({ desktop_set_api_base: { apiBaseUrl: 'https://green.example.com', apiBaseLocked: false } });
    await switchServer('https://green.example.com');
    expect(invoke.mock.calls).toEqual([
      ['desktop_set_api_base', { url: 'https://green.example.com' }],
      ['desktop_restart', {}],
    ]);
  });

  it('restarts once after the shell reloaded the page with the old address', () => {
    const invoke = shell({}, 'http://localhost:3000');
    localStorage.setItem('greenhouse.desktop.server-switch', 'https://green.example.com');
    finishServerSwitch();
    expect(invoke).toHaveBeenCalledWith('desktop_restart', {});
    invoke.mockClear();
    finishServerSwitch();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not restart when the new address is already loaded', () => {
    const invoke = shell({}, 'https://green.example.com');
    localStorage.setItem('greenhouse.desktop.server-switch', 'https://green.example.com');
    finishServerSwitch();
    expect(invoke).not.toHaveBeenCalled();
    expect(localStorage.getItem('greenhouse.desktop.server-switch')).toBeNull();
  });

  it('leaves nothing behind when a locked shell refuses', async () => {
    const invoke = shell({ desktop_set_api_base: new Error('The server is fixed in this build') });
    await expect(switchServer('https://green.example.com')).rejects.toThrow('fixed');
    expect(invoke).not.toHaveBeenCalledWith('desktop_restart', {});
    expect(localStorage.getItem('greenhouse.desktop.server-switch')).toBeNull();
    expect(localStorage.getItem('greenhouse.desktop.server')).toBeNull();
  });
});
