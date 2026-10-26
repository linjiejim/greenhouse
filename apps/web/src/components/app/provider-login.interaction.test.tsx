/** @vitest-environment happy-dom */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../extensions', () => ({
  publicLoginProviders: (ids: ReadonlySet<string>) =>
    ids.has('fixture') ? [{ id: 'fixture', login: () => <button>Fixture login</button> }] : [],
}));
import { PublicProviderLogin } from './provider-login';
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});
async function render(providers: Array<{ id: string; login: boolean }>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ providers }) });
  vi.stubGlobal('fetch', fetch);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<PublicProviderLogin onSuccess={() => {}} onError={() => {}} />));
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/auth/providers'));
  return host;
}
it('offers only public login-capable providers', async () => {
  expect((await render([{ id: 'fixture', login: true }])).textContent).toBe('Fixture login');
});
it('shows no login button when plugins are disabled or only support binding', async () => {
  expect((await render([{ id: 'fixture', login: false }])).textContent).toBe('');
});
