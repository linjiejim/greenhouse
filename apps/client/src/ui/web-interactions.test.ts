/** Web event/accessibility regressions; native and router hosts are mocked at the boundary. */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

const harness = await vi.hoisted(async () => {
  const { Window } = await import('happy-dom');
  const window = new Window();
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('localStorage', window.localStorage);
  const { createRequire } = await import('node:module');
  const { resolve } = await import('node:path');
  const req = createRequire(resolve('package.json'));
  return {
    React: req('react') as typeof import('react'),
    jsx: req('react/jsx-runtime'),
    jsxDev: req('react/jsx-dev-runtime'),
    createRoot: req('react-dom/client').createRoot as typeof import('react-dom/client').createRoot,
    window,
    width: 1440,
    state: { index: 0, routes: [] as { key: string; name: string; params?: object }[] },
  };
});
vi.mock('react', () => ({ ...harness.React, default: harness.React }));
vi.mock('react/jsx-runtime', () => harness.jsx);
vi.mock('react/jsx-dev-runtime', () => harness.jsxDev);
vi.mock('react-native', () => {
  const view = ({ children, accessibilityLabel, accessibilityRole, style: _style, ...props }: any) =>
    harness.React.createElement(
      'div',
      { ...props, role: accessibilityRole, 'aria-label': accessibilityLabel },
      children,
    );
  return {
    View: view,
    Text: ({ children }: any) => harness.React.createElement('span', null, children),
    StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ width: harness.width }),
    // RN-web PressResponder stops click bubbling even without an onPress.
    Pressable: ({
      children,
      onPress,
      disabled,
      style: _style,
      hitSlop: _hit,
      onLongPress: _long,
      delayLongPress: _delay,
      ...props
    }: any) =>
      view({
        ...props,
        tabIndex: disabled ? -1 : 0,
        children,
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          if (!disabled) onPress?.(e);
        },
      }),
  };
});
vi.mock('./icon-map', () => ({ webIcons: {} }));
vi.mock('./haptics', () => ({ tapLight: vi.fn(), tapMedium: vi.fn(), selectionTick: vi.fn() }));
vi.mock('./core', async () => import('./core.web'));
vi.mock('../theme', () => ({
  useTheme: () => ({ colors: {}, hex: {} }),
  makeStyles: (create: (colors: object) => object) => create,
  typo: { subheadline: {}, caption1: {} },
  weight: {},
  radius: {},
  space: {},
  squircle: {},
  HIT: 44,
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ canDismiss: () => true, dismiss: vi.fn() }) }));
vi.mock('expo-router/react-navigation', () => ({ useNavigationState: (select: any) => select(harness.state) }));
vi.mock('./sheet-actions', () => ({ SheetFrame: ({ children }: any) => children }));
vi.mock('../shell/inspector.web', () => ({ useInspector: { setState: vi.fn(), getState: () => ({}) } }));
vi.mock('./overlay.web', async () => ({
  ...(await vi.importActual<object>('./overlay.web')),
  Overlay: () => null,
  hasInteractiveOverlay: () => false,
}));
vi.mock('../lib/i18n', () => ({ useT: () => (key: string) => key }));
vi.mock('./avatar', () => ({ Avatar: () => null }));
vi.mock('./menu.web', () => ({ NativeMenu: ({ children }: any) => children }));

import { Touchable } from './core.web';
import { Chip } from './chip';
import { sheetEdgeLayout } from './sheet-edge.web';
import ProjectBoard from '../projects/board';
import { labelByHeading, trapTabIn } from './overlay.web';

const { createElement: h, act } = harness.React;
let host: HTMLDivElement, root: ReturnType<typeof harness.createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.width = 1440;
  host = document.createElement('div');
  document.body.append(host);
  root = harness.createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
afterAll(() => {
  harness.window.close();
  vi.unstubAllGlobals();
});

it('exposes and updates radio/checkbox state through the web primitive', async () => {
  function Choice() {
    const [checked, setChecked] = harness.React.useState(false);
    return h(Touchable, {
      accessibilityRole: 'radio',
      accessibilityLabel: '办公桌椅',
      accessibilityState: { checked },
      onPress: () => setChecked(true),
      children: '办公桌椅',
    });
  }
  await act(async () => root.render(h(Choice)));
  expect(host.querySelector('[role=radio]')?.getAttribute('aria-checked')).toBe('false');
  await act(async () => host.querySelector<HTMLElement>('[role=radio]')!.click());
  expect(host.querySelector('[role=radio]')?.getAttribute('aria-checked')).toBe('true');
  await act(async () => root.render(h(Choice)));
  expect(host.querySelector('[role=radio]')?.getAttribute('aria-checked')).toBe('true');
  await act(async () =>
    root.render(
      h(Touchable, {
        accessibilityRole: 'checkbox',
        accessibilityState: { checked: 'mixed' },
        onPress: () => {},
        children: 'Multiple choices',
      }),
    ),
  );
  expect(host.querySelector('[role=checkbox]')?.getAttribute('aria-checked')).toBe('mixed');
});

it('opens a record when the click lands on its passive enum Chip', async () => {
  const open = vi.fn();
  await act(async () =>
    root.render(
      h(
        'table',
        null,
        h('tbody', null, h('tr', { onClick: open }, h('td', null, h(Chip, { label: 'open', inline: true })))),
      ),
    ),
  );
  expect(host.querySelector('[tabindex]')).toBeNull();
  await act(async () => host.querySelector('span')!.click());
  expect(open).toHaveBeenCalledOnce();
});

it('keeps actionable Chips focusable and activates them without opening their containing row', async () => {
  const open = vi.fn(),
    action = vi.fn();
  await act(async () => root.render(h('div', { onClick: open }, h(Chip, { label: 'Document', onPress: action }))));
  const chip = host.querySelector<HTMLElement>('[role=button]')!;
  expect(chip.tabIndex).toBe(0);
  await act(async () => chip.click());
  expect(action).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
});

it('exposes the visible main grid beside inspectors, restoring phone and covered-route semantics', async () => {
  const main = { key: 'main', name: '(drawer)' };
  const inspector = { key: 'record', name: 'sheet/record' };
  // `stackHides: false` is NativeStack showing the route again: it drops aria-hidden, not inert
  const render = (routes: typeof harness.state.routes, width = 1440, stackHides = true) => {
    harness.width = width;
    harness.state = { routes, index: routes.length - 1 };
    root.render(
      h(
        'div',
        { 'aria-hidden': stackHides ? routes.at(-1)?.key !== main.key : undefined },
        h(sheetEdgeLayout, {
          route: main,
          children: h(
            'table',
            null,
            h(
              'tbody',
              null,
              h('tr', { 'aria-label': 'Wayne Enterprises', 'aria-selected': true }, h('td', null, 'Wayne Enterprises')),
            ),
          ),
        }),
      ),
    );
  };
  // a hidden route also leaves the tab order (inert), so focus cannot land behind a sheet
  const covered = () => host.querySelector('tr')?.closest('[aria-hidden]');
  for (const width of [1440, 1280, 1024]) {
    await act(async () => render([main, inspector], width));
    expect(covered()?.getAttribute('aria-hidden')).toBe('false');
    expect(covered()?.hasAttribute('inert')).toBe(false);
  }
  await act(async () => render([main, inspector, { key: 'task', name: 'sheet/task' }]));
  expect(host.querySelector('tr')?.closest('[aria-hidden]')?.getAttribute('aria-hidden')).toBe('false');
  await act(async () => render([main, inspector], 390));
  expect(host.querySelector('tr')?.closest('[aria-hidden]')?.getAttribute('aria-hidden')).toBe('true');
  expect(covered()?.hasAttribute('inert')).toBe(true);
  await act(async () => render([main, { key: 'plugin', name: 'p/[plugin]/[page]' }, inspector]));
  expect(host.querySelector('tr')?.closest('[aria-hidden]')?.getAttribute('aria-hidden')).toBe('true');
  await act(async () => render([main]));
  expect(host.querySelector('tr')?.closest('[aria-hidden]')?.getAttribute('aria-hidden')).toBe('false');
  expect(covered()?.hasAttribute('inert')).toBe(false);
  await act(async () => render([main, inspector], 390));
  expect(covered()?.hasAttribute('inert')).toBe(true);
  await act(async () => render([main], 390, false));
  expect(host.querySelector('tr')?.closest('[inert]')).toBeNull();
});

it('names a passive Touchable by its content: the web forbids aria-label on a plain element', async () => {
  await act(async () =>
    root.render(
      h('div', null, h(Touchable, { accessibilityLabel: 'policy', children: 'policy' }), h(Chip, { label: 'Doc', onPress: () => {} })),
    ),
  );
  const passive = host.querySelector('div > div')!;
  expect(passive.getAttribute('aria-label')).toBeNull();
  expect(passive.getAttribute('aria-disabled')).toBeNull();
  expect(host.querySelector('[role=button]')?.getAttribute('aria-label')).toBe('Doc');
});

it('lets a menu trigger’s own button take focus and announce the menu; a passive child makes the wrapper the stop', async () => {
  const { NativeMenu } = await vi.importActual<typeof import('./menu.web')>('./menu.web');
  const items = [{ id: 'a', title: 'A' }];
  await act(async () =>
    root.render(h(NativeMenu, { items, onSelect: () => {}, children: h('button', { 'aria-label': '更多' }) })),
  );
  const wrapper = host.firstElementChild!;
  expect(wrapper.getAttribute('tabindex')).toBeNull();
  expect(wrapper.getAttribute('role')).toBeNull();
  expect(host.querySelector('button')?.getAttribute('aria-haspopup')).toBe('menu');
  expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  await act(async () => root.render(h(NativeMenu, { items, onSelect: () => {}, children: h('span', null, '排序') })));
  expect(host.firstElementChild?.getAttribute('tabindex')).toBe('0');
  expect(host.firstElementChild?.getAttribute('role')).toBe('button');
  expect(host.firstElementChild?.getAttribute('aria-haspopup')).toBe('menu');
});

it('keeps Tab inside a modal surface and names a dialog after the heading it renders', async () => {
  const dialog = document.createElement('div');
  dialog.innerHTML = '<button id="first">a</button><button id="last">b</button>';
  const outside = document.createElement('button');
  document.body.append(dialog, outside);
  const tab = (shiftKey = false) => {
    const event = new harness.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });
    trapTabIn(dialog, event as unknown as KeyboardEvent);
    return event.defaultPrevented;
  };
  outside.focus();
  expect(tab()).toBe(true);
  expect(document.activeElement?.id).toBe('first');
  expect(tab(true)).toBe(true);
  expect(document.activeElement?.id).toBe('last');
  expect(tab()).toBe(true);
  expect(document.activeElement?.id).toBe('first');

  vi.stubGlobal('MutationObserver', harness.window.MutationObserver);
  const stop = labelByHeading(dialog);
  expect(dialog.getAttribute('aria-labelledby')).toBeNull();
  const title = document.createElement('h2');
  title.textContent = '新建任务';
  dialog.prepend(title);
  await new Promise((done) => setTimeout(done, 0));
  expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
  stop();
  dialog.remove();
  outside.remove();
});

it('drags a board task to the completed region and opens it in board and gantt views', async () => {
  const open = vi.fn(),
    move = vi.fn();
  const task = {
    id: 'task',
    title: '定价页文案',
    status: 'in_progress',
    priority: 'high',
    due_date: '2026-10-30',
    created_at: '2026-10-01',
  };
  const render = (status: string, view = 'kanban') =>
    root.render(
      h(ProjectBoard, {
        tasks: [{ ...task, status }] as any,
        view,
        busy: false,
        labels: { done: '已完成', in_progress: '进行中' },
        onOpen: open,
        onMove: move,
        onContext: () => {},
      }),
    );
  await act(async () => render('in_progress'));
  const values = new Map<string, string>();
  const transfer = {
    setData: (key: string, value: string) => values.set(key, value),
    getData: (key: string) => values.get(key),
  };
  const drag = (node: Element, type: string) => {
    const event = new harness.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    node.dispatchEvent(event);
  };
  await act(async () => {
    drag(host.querySelector('.gh-task-card')!, 'dragstart');
    drag(host.querySelector('section[aria-label="已完成"]')!, 'drop');
  });
  expect(move).toHaveBeenCalledExactlyOnceWith('task', 'done');
  await act(async () => render('done'));
  await act(async () => host.querySelector<HTMLButtonElement>('section[aria-label="已完成"] button')!.click());
  expect(open).toHaveBeenLastCalledWith('task');
  await act(async () => render('done', 'gantt'));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="project-gantt"] button')!.click());
  expect(open).toHaveBeenCalledTimes(2);
});
