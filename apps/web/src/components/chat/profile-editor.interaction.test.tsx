/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Profile } from '../../lib/api';
import { I18nProvider } from '../../lib/i18n';
import { useProfileStore } from '../../stores';
import { ProfileEditorDrawer } from './profile-editor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  // `initialized` keeps the editor's fetchProfiles() from touching the network.
  useProfileStore.setState({
    initialized: true,
    models: [
      { id: 'flash', name: 'Default model' },
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
    ],
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useProfileStore.setState({ initialized: false, models: [] });
});

async function mountEditor(profile: Profile | null) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ProfileEditorDrawer, {
          open: true,
          onClose: vi.fn(),
          profile,
          availableTools: [],
          isSuper: false,
          onSave: vi.fn(),
        }),
      }),
    ),
  );
  const selects = [...document.querySelectorAll('select')];
  const modelSelect = selects.find((s) => [...s.options].some((o) => o.value === 'deepseek-flash'));
  expect(modelSelect).toBeDefined();
  return modelSelect!;
}

describe('ProfileEditorDrawer model choice', () => {
  it('offers the catalog models the Chat picker offers, not a hard-coded list', async () => {
    const select = await mountEditor(null);
    expect([...select.options].map((o) => o.value)).toEqual(['flash', 'deepseek-flash']);
    expect([...select.options].map((o) => o.textContent)).toContain('deepseek-flash — DeepSeek V4.1 Flash');
    expect(select.value).toBe('flash');
  });

  // The Agent already runs on the default (resolveProfileAsync falls back);
  // showing the retired id would also make Save send a value the server rejects.
  it('shows the default for an Agent pinned to a model the catalog no longer offers', async () => {
    const select = await mountEditor({
      id: 'custom:7',
      name: 'Emailer',
      system_prompt: 'Draft replies.',
      tools: [],
      model_id: 'minimax-m3',
      is_custom: true,
    } as unknown as Profile);
    expect([...select.options].map((o) => o.value)).not.toContain('minimax-m3');
    expect(select.value).toBe('flash');
  });
});
