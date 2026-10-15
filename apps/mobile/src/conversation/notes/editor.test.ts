import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const test = await vi.hoisted(async () => {
  const { Window } = await import('happy-dom');
  const window = new Window();
  for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator }))
    vi.stubGlobal(name, value);
  const { createRequire } = await import('node:module');
  const { resolve } = await import('node:path');
  const require = createRequire(resolve('apps/web/package.json'));
  const React = require('react') as typeof import('react');
  return {
    React,
    window,
    jsx: require('react/jsx-runtime'),
    jsxDev: require('react/jsx-dev-runtime'),
    createRoot: require('react-dom/client').createRoot as typeof import('react-dom/client').createRoot,
    focused: true,
    identity: 'lin',
    router: { push: vi.fn(), back: vi.fn() },
    navigation: { addListener: vi.fn(() => () => {}) },
    post: vi.fn(),
    patch: vi.fn(),
    alert: vi.fn(),
    prompt: vi.fn(),
    note: { id: 'note-a', conversation_id: 'room-a', body: 'Original text', title: 'Note' },
  };
});
vi.mock('react', () => ({ ...test.React, default: test.React }));
vi.mock('react/jsx-runtime', () => test.jsx);
vi.mock('react/jsx-dev-runtime', () => test.jsxDev);
vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  FlatList: ({ data, renderItem }: any) =>
    test.React.createElement(
      'div',
      null,
      ...data.map((item: unknown, index: number) =>
        test.React.createElement('div', { key: index }, renderItem({ item, index })),
      ),
    ),
}));
vi.mock('expo-router', () => ({
  useRouter: () => test.router,
  useNavigation: () => test.navigation,
  useIsFocused: () => test.focused,
  useLocalSearchParams: () => ({ c: 'room-a' }),
  Stack: Object.assign(() => null, {
    Screen: () => null,
    Toolbar: Object.assign(({ children }: any) => children, {
      Button: ({ onPress, accessibilityLabel }: any) =>
        test.React.createElement('button', { onClick: onPress }, accessibilityLabel),
    }),
  }),
}));
vi.mock('../../api/client', () => ({
  post: test.post,
  patch: test.patch,
  get: vi.fn(),
  del: vi.fn(),
  seg: encodeURIComponent,
}));
vi.mock('../../data/identity', () => ({
  captureIdentity: () => {
    const identity = test.identity;
    return () => identity === test.identity;
  },
}));
vi.mock('../../data/use-resource', () => ({
  useResource: () => ({
    data: { items: [test.note] },
    loading: false,
    refresh: vi.fn(),
    captureWrite: () => () => true,
  }),
}));
vi.mock('../../lib/i18n', () => ({ useT: () => (key: string) => key }));
vi.mock('../../ui/dialogs', () => ({ alertError: test.alert, promptText: test.prompt, confirmAction: vi.fn() }));
vi.mock('../../ui/sheet-chrome', () => ({ SheetClose: () => null }));
vi.mock('../../ui/toolbar-icon', () => ({ toolbarIcon: (name: string) => name }));
vi.mock('../../ui/list', () => ({
  ListRow: ({ title, onPress }: any) => test.React.createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../ui/menu', () => ({ NativeMenu: ({ children }: any) => children }));
vi.mock('../../ui/empty', () => ({ EmptyState: () => null }));
vi.mock('../../ui/button', () => ({ NativeButton: () => null }));
vi.mock('../../knowledge/state', () => ({ ResourceState: () => null }));

import Notes from '../../../app/notes';
import { clearHandoffs, putHandoff } from '../../lib/handoff';
import { useNote } from './use-note';

const { act, createElement: h } = test.React;
let root: ReturnType<typeof test.createRoot>;
let container: HTMLDivElement;
let form: ReturnType<typeof useNote>;
function Editor({ handoff }: { handoff?: string }) {
  form = useNote('room-a', handoff);
  return null;
}
async function render(element: ReturnType<typeof h>) {
  await act(async () => {
    root.render(element);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  clearHandoffs();
  test.focused = true;
  test.identity = 'lin';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = test.createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});
afterAll(async () => {
  await test.window.happyDOM.close();
  vi.unstubAllGlobals();
});

describe('shared-note navigation', () => {
  it('opens route-owned create/edit forms without a global prompt, including after repaint', async () => {
    await render(h(Notes));
    await act(async () => {
      [...container.querySelectorAll('button')].find((x) => x.textContent === 'integration.newNote')!.click();
    });
    expect(test.router.push).toHaveBeenLastCalledWith({ pathname: '/note', params: { c: 'room-a' } });
    await act(async () => {
      [...container.querySelectorAll('button')].find((x) => x.textContent === 'Note')!.click();
    });
    expect(test.router.push).toHaveBeenLastCalledWith({
      pathname: '/note',
      params: { c: 'room-a', k: expect.stringMatching(/^note_/) },
    });
    await render(h(Notes));
    expect(test.router.push).toHaveBeenCalledTimes(2);
    expect(test.prompt).not.toHaveBeenCalled();
  });

  it('preserves a multiline draft on blur/repaint and cannot save from behind another route', async () => {
    await render(h(Editor));
    await act(async () => {
      form.setBody('First line\nSecond line');
    });
    test.focused = false;
    await render(h(Editor));
    await act(async () => {
      await form.save();
    });
    expect(form.body).toBe('First line\nSecond line');
    expect(form.canSave).toBe(false);
    expect(test.post).not.toHaveBeenCalled();
    expect(test.prompt).not.toHaveBeenCalled();
    test.focused = true;
    await render(h(Editor));
    test.post.mockResolvedValue({ ok: true, data: {} });
    await act(async () => {
      await form.save();
    });
    expect(test.post).toHaveBeenCalledWith('/api/conversations/room-a/notes', { body: 'First line\nSecond line' });
    expect(test.router.back).toHaveBeenCalledTimes(1);
  });

  it('does not pop the destination when a save finishes after a deep link', async () => {
    let resolve!: (value: unknown) => void;
    test.post.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render(h(Editor));
    await act(async () => {
      form.setBody('Draft');
    });
    let saved!: Promise<void>;
    await act(async () => {
      saved = form.save();
    });
    test.focused = false;
    await render(h(Editor));
    await act(async () => {
      resolve({ ok: true, data: {} });
      await saved;
    });
    expect(test.router.back).not.toHaveBeenCalled();
    expect(test.alert).not.toHaveBeenCalled();
    test.focused = true;
    await render(h(Editor));
    expect(test.router.back).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale toolbar handler after blur, identity change or unmount', async () => {
    await render(h(Editor));
    await act(async () => {
      form.setBody('Private draft');
    });
    const staleSave = form.save;
    test.focused = false;
    await render(h(Editor));
    await act(async () => {
      await staleSave();
    });
    test.focused = true;
    test.identity = 'mei';
    await render(h(Editor));
    await act(async () => {
      await staleSave();
    });
    await render(h('div'));
    await act(async () => {
      await staleSave();
    });
    expect(test.post).not.toHaveBeenCalled();
  });

  it.each(['blur', 'identity', 'unmount'])('does not show late failure alerts after %s', async (cause) => {
    let resolve!: (value: unknown) => void;
    test.post.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render(h(Editor));
    await act(async () => {
      form.setBody('Draft');
    });
    let saved!: Promise<void>;
    await act(async () => {
      saved = form.save();
    });
    if (cause === 'blur') {
      test.focused = false;
      await render(h(Editor));
    }
    if (cause === 'identity') test.identity = 'mei';
    if (cause === 'unmount') await render(h('div'));
    await act(async () => {
      resolve({ ok: false, message: 'Failed' });
      await saved;
    });
    expect(test.alert).not.toHaveBeenCalled();
    expect(test.router.back).not.toHaveBeenCalled();
  });

  it('rejects expired or foreign-conversation edit handoffs', async () => {
    for (const handoff of ['note_expired', putHandoff('note', { ...test.note, conversation_id: 'another-room' })]) {
      await render(h(Editor, { key: handoff, handoff }));
      await act(async () => {
        form.setBody('Draft');
        await form.save();
      });
      expect(form.ready).toBe(false);
    }
    expect(test.patch).not.toHaveBeenCalled();
    expect(test.post).not.toHaveBeenCalled();
  });

  it('edits the selected note body through the same conversation boundary', async () => {
    const handoff = putHandoff('note', test.note);
    await render(h(Editor, { handoff }));
    expect(form.body).toBe('Original text');
    await act(async () => {
      form.setBody('Updated\nBody');
    });
    test.patch.mockResolvedValue({ ok: true, data: {} });
    await act(async () => {
      await form.save();
    });
    expect(test.patch).toHaveBeenCalledWith('/api/conversations/room-a/notes/note-a', { body: 'Updated\nBody' });
    expect(test.post).not.toHaveBeenCalled();
    expect(test.router.back).toHaveBeenCalledTimes(1);
  });
});
