/** @vitest-environment happy-dom */

/**
 * The Phase 1 app router (`AppsPage`): addresses that are not an app. The app
 * center, the runtime and the builder have their own tests next to them
 * (`center/`, `runtime/`, `builder/`).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRuntimeView, AppSummary } from '@greenhouse/types/apps';
import { I18nProvider } from '../../lib/i18n';
import { useAppsStore } from '../../stores/apps-store';
import { AppsPage } from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const enrichPageContext = vi.hoisted(() => vi.fn());
vi.mock('../../components/agent-context', () => ({ useAgentContext: () => ({ enrichPageContext }) }));

const api = vi.hoisted(() => ({ getApp: vi.fn<(appId: number) => Promise<AppRuntimeView>>() }));
vi.mock('../../lib/api/apps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/apps')>()),
  ...api,
}));

const load = vi.fn(async () => {});
const setPinned = vi.fn(async () => {});
const original = { load: useAppsStore.getState().load, setPinned: useAppsStore.getState().setPinned };

function seed(
  catalog: { managed?: AppSummary[]; shared?: AppSummary[]; featured?: AppSummary[] } | null,
  pinnedIds: number[] = [],
) {
  act(() =>
    useAppsStore.setState({
      catalog: catalog ? { managed: [], shared: [], featured: [], ...catalog } : null,
      pinnedIds,
      status: catalog ? 'ready' : 'loading',
      load,
      setPinned,
    }),
  );
}

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(subPath: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <I18nProvider initialLocale="en">
        <AppsPage subPath={subPath} />
      </I18nProvider>,
    ),
  );
}

beforeEach(() => {
  load.mockClear();
  setPinned.mockClear();
  enrichPageContext.mockClear();
  api.getApp.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  useAppsStore.getState().clear();
  useAppsStore.setState(original);
});

describe('bad addresses', () => {
  it('rejects an address that is not an app', async () => {
    seed({});
    await mount('abc');
    expect(container.textContent).toContain('This app address is not valid.');
  });
});
