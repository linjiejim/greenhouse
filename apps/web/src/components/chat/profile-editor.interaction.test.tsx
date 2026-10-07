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

describe('ProfileEditorDrawer appearance', () => {
  const legacyAgent = {
    id: 'custom:7',
    name: 'Emailer',
    system_prompt: 'Draft replies.',
    tools: [],
    model_id: 'flash',
    is_custom: true,
    avatar: { color: 'ocean', accessories: ['crown'], eyeStyle: 'focused' },
  } as unknown as Profile;

  async function mount(profile: Profile | null) {
    const onSave = vi.fn().mockResolvedValue(undefined);
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
            onSave,
          }),
        }),
      ),
    );
    return onSave;
  }
  const summary = () => document.querySelector('[data-testid="profile-appearance-summary"]')!.textContent;
  const openAppearance = () =>
    act(async () => document.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
  const click = (selector: string) => act(async () => document.querySelector<HTMLButtonElement>(selector)!.click());

  it('summarises a legacy Agent as the plant and mood it renders as', async () => {
    await mount(legacyAgent);
    expect(summary()).toBe('Echeveria · Drowsy');
  });

  it('saves plant + legacy colour + faceStyle merged into the stored avatar', async () => {
    const onSave = await mount(legacyAgent);
    await openAppearance();
    await click('button[data-plant="ginkgo"]');
    await click('button[data-mood="bright"]');
    expect(summary()).toBe('Ginkgo · Bright');
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save Changes')!;
    await act(async () => save.click());
    expect(onSave).toHaveBeenCalledTimes(1);
    const [input, editId] = onSave.mock.calls[0]!;
    expect(editId).toBe(7);
    // Accessories and eyeStyle stay stored (rollback-safe); the plant and mood now win.
    expect(input.avatar).toEqual({
      color: 'sunset',
      accessories: ['crown'],
      eyeStyle: 'focused',
      plant: 'ginkgo',
      faceStyle: 'sparkle',
    });
  });

  it("gives a new Agent a plant none of the member's custom Agents wears", async () => {
    useProfileStore.setState({
      profiles: [
        { id: 'sprouty', name: 'Sprouty', tools: [] },
        { id: 'custom:1', name: 'A', tools: [], is_custom: true, avatar: { plant: 'basil' } },
        {
          id: 'custom:2',
          name: 'B',
          tools: [],
          is_custom: true,
          avatar: { color: 'forest', accessories: ['magnifier'] },
        },
      ] as unknown as Profile[],
    });
    try {
      await mount(null);
      // basil is taken outright, sage by a legacy magnifier avatar → the next free species.
      expect(summary()).toBe('Monstera · Calm');
    } finally {
      useProfileStore.setState({ profiles: [] });
    }
  });

  it('previews all eight states at 120px, morphing the same avatar in place', async () => {
    await mount(legacyAgent);
    await openAppearance();
    const preview = () => document.querySelector<HTMLSpanElement>('.pa-root[role="img"]')!;
    expect(preview().style.width).toBe('120px');
    const stateChips = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Preview state"] button')];
    expect(stateChips.map((b) => b.textContent)).toEqual([
      'Idle',
      'Thinking',
      'Speaking',
      'Done',
      'Error',
      'Waiting',
      'Asleep',
      'Saying hi',
    ]);
    const svg = preview().querySelector('svg')!;
    await act(async () => stateChips[1]!.click());
    expect(preview().querySelector('svg')).toBe(svg);
    expect(svg.getAttribute('data-state')).toBe('thinking');
    expect(preview().getAttribute('aria-label')).toBe('Echeveria · Thinking');
  });
});
