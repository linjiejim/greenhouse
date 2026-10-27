import { afterEach, expect, it, vi } from 'vitest';
const harness = await vi.hoisted(async () => {
  const { Window } = await import('happy-dom');
  const window = new Window();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    vi.stubGlobal(key, value);
  const { createRequire } = await import('node:module');
  const { resolve } = await import('node:path');
  const req = createRequire(resolve('package.json'));
  return {
    React: req('react'),
    createRoot: req('react-dom/client').createRoot,
    focused: true,
    get: vi.fn(),
    station: 'station',
    member: 'member',
  };
});
vi.mock('react', () => ({ ...harness.React, default: harness.React }));
vi.mock('expo-router', () => ({ useIsFocused: () => harness.focused }));
vi.mock('../api/client', () => ({ get: harness.get }));
vi.mock('../data/identity', () => ({
  captureIdentity: () => {
    const sid = harness.station;
    return () => sid === harness.station;
  },
}));
vi.mock('../store/auth', () => ({ useAuth: (s: any) => s({ user: { id: harness.member } }) }));
vi.mock('../store/stations', () => ({ useStations: (s: any) => s({ activeId: harness.station }) }));
import { useEntityList } from './entity-hooks';
import type { PluginEntitySchema } from '../shared/plugins';
const entity = {
  endpoint: '/api/ext/crm/companies',
  fields: [{ key: 'amount', kind: 'number', sortable: true }],
  views: [],
  id: 'company',
} as unknown as PluginEntitySchema;
const roots: any[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await harness.React.act(() => root.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
});
it('retains loaded pages and scroll through inspector focus changes, reloads only on query or refresh', async () => {
  const {
    React: { createElement: h, act },
  } = harness;
  harness.get.mockImplementation(async (url: string) => ({
    ok: true,
    data: {
      total: 2,
      items: [{ id: new URL(url, 'https://station.test').searchParams.get('skip') === '0' ? 'first' : 'second' }],
    },
  }));
  let list: ReturnType<typeof useEntityList>;
  function Screen({ dir = 'asc' }: { dir?: 'asc' | 'desc' }) {
    list = useEntityList(entity, undefined, {}, { field: 'amount', dir });
    return h(
      'div',
      { 'data-testid': 'scroll' },
      list.items.map((r) => h('p', { key: r.id }, r.id)),
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = harness.createRoot(host);
  roots.push(root);
  await act(async () => root.render(h(Screen)));
  await act(async () => list.more());
  const scroll = host.firstElementChild as HTMLDivElement;
  scroll.scrollTop = 240;
  for (const focused of [false, true]) {
    harness.focused = focused;
    await act(async () => root.render(h(Screen)));
  }
  expect(host.textContent).toBe('firstsecond');
  expect(host.firstElementChild).toBe(scroll);
  expect(scroll.scrollTop).toBe(240);
  expect(harness.get).toHaveBeenCalledTimes(2);
  await act(async () => root.render(h(Screen, { dir: 'desc' })));
  expect(host.textContent).toBe('first');
  expect(harness.get).toHaveBeenCalledTimes(3);
  await act(async () => list.refresh());
  expect(harness.get).toHaveBeenCalledTimes(4);
});
it('discards a late old-query page after sort changes', async () => {
  const {
    React: { createElement: h, act },
  } = harness;
  let release: ((value: unknown) => void) | undefined;
  harness.get
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    )
    .mockResolvedValue({ ok: true, data: { items: [{ id: 'current' }], total: 1 } });
  function Screen({ dir }: { dir: 'asc' | 'desc' }) {
    const list = useEntityList(entity, undefined, {}, { field: 'amount', dir });
    return h('div', null, list.items.map((r) => r.id).join(','));
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = harness.createRoot(host);
  roots.push(root);
  await act(async () => root.render(h(Screen, { dir: 'asc' })));
  await act(async () => root.render(h(Screen, { dir: 'desc' })));
  await act(async () => release!({ ok: true, data: { items: [{ id: 'stale' }], total: 1 } }));
  expect(host.textContent).toBe('current');
});
it('keeps the previous rows and total until a refresh completes, including failed refreshes', async () => {
  const {
    React: { createElement: h, act },
  } = harness;
  let list: ReturnType<typeof useEntityList>, release: ((value: unknown) => void) | undefined;
  harness.get.mockResolvedValueOnce({ ok: true, data: { items: [{ id: 'saved' }], total: 9 } }).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  function Screen() {
    list = useEntityList(entity, undefined, {});
    return h('p', null, `${list.items.map((r) => r.id).join(',')}:${list.total}:${list.loading}`);
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = harness.createRoot(host);
  roots.push(root);
  await act(async () => root.render(h(Screen)));
  let pending: Promise<void>;
  await act(async () => {
    pending = list.refresh();
  });
  expect(host.textContent).toBe('saved:9:true');
  await act(async () => {
    release!({ ok: false, message: 'Offline' });
    await pending;
  });
  expect(host.textContent).toBe('saved:9:false');
  await act(async () => {
    pending = list.refresh();
  });
  expect(host.textContent).toBe('saved:9:true');
  await act(async () => {
    release!({ ok: true, data: { items: [{ id: 'fresh' }], total: 10 } });
    await pending;
  });
  expect(host.textContent).toBe('fresh:10:false');
});
