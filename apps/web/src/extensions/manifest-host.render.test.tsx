/** @vitest-environment happy-dom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PluginManifestEntry } from '@greenhouse/types/plugins';
import { I18nProvider } from '../lib/i18n';
import { useExtensionsStore } from '../stores/extensions-store';
import { useAuthStore } from '../stores/auth-store';
import { ManifestPageHost } from './manifest-host';
import { embedNavigation, embedTheme } from './embed-page';
import { entityDataSource } from './entity-page';

const fetcher = vi.hoisted(() => vi.fn());
vi.mock('../lib/auth', () => ({ authFetch: fetcher }));
vi.mock('../lib/api/workspace-settings', () => ({ fetchWorkspaceSettings: vi.fn(), saveWorkspaceSettings: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const plugin: PluginManifestEntry = {
  id: 'fixture',
  name: 'Fixture',
  description: null,
  version: '1.0.0',
  official: false,
  features: [],
  mcp_groups: [],
  entity_kinds: [],
  nav: [],
  pages: [
    { id: 'records', kind: 'entity-list', entity: 'fixture.record', title: 'Records' },
    { id: 'record', kind: 'entity-detail', entity: 'fixture.record', title: 'Record' },
  ],
  entities: [
    {
      id: 'fixture.record',
      title: 'Record',
      title_field: 'name',
      endpoint: '/api/ext/fixture/entities/record',
      kind: 'ext:fixture:record',
      actions: ['read', 'update'],
      fields: [
        { key: 'id', title: 'ID', kind: 'text' },
        { key: 'name', title: 'Name', kind: 'text', writable: true },
        { key: 'unchanged', title: 'Unchanged', kind: 'json', writable: true },
        { key: 'userId', title: 'Owner', kind: 'user', writable: false },
        { key: 'createdAt', title: 'Created', kind: 'dateTime', writable: false },
      ],
      views: [{ id: 'default', columns: ['name'] }],
    },
  ],
};
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  fetcher.mockReset();
  useExtensionsStore.setState({ plugins: [plugin], extensions: [], loaded: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useExtensionsStore.getState().reset();
  useAuthStore.getState().logout();
  document.documentElement.removeAttribute('style');
  document.documentElement.classList.remove('dark-theme');
});
const render = async (subPath: string) =>
  act(async () =>
    root.render(
      <I18nProvider initialLocale="en">
        <ManifestPageHost subPath={subPath} params={new URLSearchParams()} />
      </I18nProvider>,
    ),
  );
it('renders manifest-only lists and linked record details with the shared CRUD components', async () => {
  const row = { id: '42', name: 'Visible record' };
  fetcher.mockImplementation(async (url: string) =>
    Response.json(url.includes('?') ? { items: [row], total: 1 } : row),
  );
  await render('fixture/records');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  expect(container.querySelector('a')?.getAttribute('href')).toBe('#/ext/fixture/record/42');
  await render('fixture/record/42');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Visible record');
  expect(fetcher).toHaveBeenCalledWith('/api/ext/fixture/entities/record/42', expect.anything());
  // Generated tool/entity links use the entity id, independent of page ids.
  await act(async () => {
    useExtensionsStore.setState({
      plugins: [{ ...plugin, pages: plugin.pages.map((p) => ({ ...p, id: `page-${p.id}` })) }],
    });
  });
  await render('fixture/record/42');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Visible record');
});
it('never renders a missing or disabled plugin surface', async () => {
  useExtensionsStore.setState({ plugins: [] });
  await render('fixture/records');
  expect(container.textContent).toContain('not enabled');
  expect(fetcher).not.toHaveBeenCalled();
});
it('uses declared writable fields and actions and the shared list protocol', async () => {
  fetcher.mockResolvedValue(Response.json({ items: [], total: 0 }));
  const ds = entityDataSource(plugin.entities[0]);
  expect(ds.create).toBeUndefined();
  expect(ds.remove).toBeUndefined();
  await ds.list({ skip: 10, limit: 20, sort: [{ key: 'name', order: 'asc' }] });
  expect(fetcher.mock.calls[0][0]).toContain('skip=10&limit=20&sort=');
  fetcher.mockImplementation(async () => Response.json({ id: '42', name: 'Edited' }));
  await ds.update!('42', { name: 'Edited', id: 'other', hidden: 'forbidden' });
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ name: 'Edited' });
  await ds.update!(
    '42',
    { name: 'Edited again', unchanged: { nested: [1] }, userId: 'other', createdAt: 'bad' },
    { id: '42', name: 'Edited', unchanged: { nested: [1] } },
  );
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ name: 'Edited again' });
});
it('saves a detail delta and keeps list rows and total while its refreshed page is pending', async () => {
  const row = {
    id: '42',
    name: 'Visible record',
    unchanged: { nested: [1] },
    userId: 'member',
    createdAt: '2026-10-26 22:50:11.703622+00',
  };
  let current = row,
    release: ((response: Response) => void) | undefined,
    saved = false;
  fetcher.mockImplementation(async (url: string, init: RequestInit) => {
    if (init.method === 'PATCH') {
      expect(JSON.parse(init.body as string)).toEqual({ name: 'Edited' });
      current = { ...row, name: 'Edited' };
      saved = true;
      return Response.json(current);
    }
    if (url.includes('?')) {
      if (saved)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return Response.json({ items: [row], total: 7 });
    }
    return Response.json(current);
  });
  await render('fixture/record/42');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  const before = container.querySelector('table');
  const edit = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Edit')!;
  await act(async () => edit.click());
  expect(document.querySelector('[data-testid="ext-fixture-fixture.record-field-userId"]')).toBeNull();
  const input = document.querySelector('[data-testid="ext-fixture-fixture.record-field-name"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Edited');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () =>
    (document.querySelector('[data-testid="ext-fixture-fixture.record-submit"]') as HTMLButtonElement).click(),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  expect(release).toBeDefined();
  expect(container.querySelector('table')).toBe(before);
  expect(container.querySelector('table')?.textContent).toContain('Visible record');
  expect(container.textContent).toContain('7 total');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Edited');
  await act(async () => release!(Response.json({ items: [current], total: 7 })));
  expect(container.querySelector('table')?.textContent).toContain('Edited');
});
it('passes computed branding and rejects navigation outside the station', () => {
  document.documentElement.style.setProperty('--t-accent', '#112233');
  expect(embedTheme().tokens['--t-accent']).toBe('#112233');
  document.documentElement.classList.add('dark-theme');
  expect(embedTheme().theme).toBe('dark');
  expect(embedNavigation('#/ext/fixture/records', window.location.origin)).toBe('#/ext/fixture/records');
  for (const href of [
    'https://evil.example/#/home',
    'javascript:alert(1)',
    '/api/admin/users',
    '//evil.example/#/chat',
  ])
    expect(embedNavigation(href, window.location.origin)).toBeNull();
});
