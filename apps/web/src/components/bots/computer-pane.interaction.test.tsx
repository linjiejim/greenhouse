/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotRequestView, ComputerStatusView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { ToastContainer } from '../ui';
import { useAuthStore } from '../../stores/auth-store';
import { BotsApiError } from '../../lib/api/bots';
import { ComputerPane, type ComputerPaneHandle, type ComputerPaneProps } from './computer-pane';
import { computerPhase, useComputerStatus, type ComputerStatusState } from './computer-phase';
import { backoffDelay } from './computer-screen';
import { formatElapsed } from './computer-controls';

// ─── Fakes ───────────────────────────────────────────────

const fakes = vi.hoisted(() => {
  type Listener = (event: CustomEvent) => void;
  class FakeRfb {
    static instances: FakeRfb[] = [];
    viewOnly = false;
    focusOnClick = true;
    scaleViewport = false;
    resizeSession = true;
    clipViewport = true;
    background = '';
    qualityLevel = 6;
    compressionLevel = 2;
    disconnected = false;
    sentKeys: number[] = [];
    private listeners = new Map<string, Set<Listener>>();
    constructor(
      public target: HTMLElement,
      public url: string,
      public options?: { shared?: boolean },
    ) {
      FakeRfb.instances.push(this);
    }
    addEventListener(type: string, listener: Listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(listener);
    }
    removeEventListener(type: string, listener: Listener) {
      this.listeners.get(type)?.delete(listener);
    }
    emit(type: string, detail: unknown = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(new CustomEvent(type, { detail }));
    }
    disconnect() {
      this.disconnected = true;
    }
    // noVNC ignores keys while view-only; the fake records what would reach the server.
    sendKey(keysym: number) {
      if (!this.viewOnly) this.sentKeys.push(keysym);
    }
    focus() {}
    blur() {}
  }
  const wsHandlers = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  return { FakeRfb, wsHandlers };
});

const api = vi.hoisted(() => ({
  fetchComputerStatus: vi.fn(),
  startComputer: vi.fn(),
  stopComputer: vi.fn(),
  resetComputer: vi.fn(),
  createComputerViewToken: vi.fn(),
  computerViewerUrl: (token: string) => `ws://greenhouse.test/api/ws/computer?token=${token}`,
  takeoverComputer: vi.fn(),
  handbackComputer: vi.fn(),
  typeIntoComputer: vi.fn(),
  listRequests: vi.fn(),
  listBots: vi.fn(),
}));

// Partial mock: the real BotsApiError / isBotsApiError stay, so the code →
// message maps are exercised with real errors.
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));
vi.mock('../../lib/novnc/loader', () => ({ loadRfb: async () => fakes.FakeRfb }));
vi.mock('../../lib/ws', () => ({
  wsClient: {
    onEvent: (handler: (event: { type: string }) => void) => {
      fakes.wsHandlers.add(handler);
      return () => fakes.wsHandlers.delete(handler);
    },
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function status(overrides: Partial<ComputerStatusView> = {}): ComputerStatusView {
  return {
    runtime: { state: 'ready', reason: null, hardened: false },
    state: 'absent',
    state_reason: null,
    controller: 'bot',
    controller_since: null,
    last_active_at: null,
    queue_position: null,
    disk_bytes: null,
    ...overrides,
  };
}

const RUNNING = status({ state: 'running' });
const IN_CONTROL = status({ state: 'running', controller: 'user', controller_since: new Date().toISOString() });

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPane(props: Partial<ComputerPaneProps> = {}, ref?: React.Ref<ComputerPaneHandle>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: [
          createElement(ComputerPane, { key: 'pane', open: true, onClose: vi.fn(), ...props, ref }),
          createElement(ToastContainer, { key: 'toasts' }),
        ],
      }),
    );
  });
  await flush();
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`No button "${text}" in: ${document.body.textContent}`);
  return button;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

/** Set a React-controlled input's value the way a user would. */
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function latestRfb() {
  const rfb = fakes.FakeRfb.instances.at(-1);
  if (!rfb) throw new Error('noVNC was never constructed');
  return rfb;
}

beforeEach(() => {
  fakes.FakeRfb.instances.length = 0;
  fakes.wsHandlers.clear();
  for (const fn of Object.values(api)) if (vi.isMockFunction(fn)) fn.mockReset();
  api.createComputerViewToken.mockResolvedValue({ token: 'tok-1', expires_at: new Date().toISOString() });
  api.listRequests.mockResolvedValue({ requests: [] });
  api.listBots.mockResolvedValue({
    bots: [],
    archived_bots: [],
    computer: RUNNING.runtime,
    vault_available: true,
    pending_requests: 0,
  });
  useAuthStore.setState({
    currentUser: { id: 'u1', role: 'team', nickname: 'Mia' } as never,
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = '';
});

// ─── Phases ──────────────────────────────────────────────

describe('computerPhase', () => {
  it('maps the server view to what the member sees', () => {
    expect(computerPhase(status({ runtime: { state: 'disabled', reason: null, hardened: false } })).kind).toBe(
      'unavailable',
    );
    expect(computerPhase(status({ runtime: { state: 'checking', reason: null, hardened: false } })).kind).toBe(
      'checking',
    );
    expect(computerPhase(status({ state_reason: 'lru' }))).toEqual({ kind: 'asleep', reason: 'lru' });
    expect(computerPhase(status(), { starting: true }).kind).toBe('starting');
    expect(computerPhase(status({ state: 'error', state_reason: 'oom' }))).toEqual({ kind: 'error', reason: 'oom' });
    expect(computerPhase(status({ queue_position: 2 }))).toEqual({ kind: 'queued', position: 2 });
    expect(computerPhase(IN_CONTROL)).toMatchObject({ kind: 'running', controller: 'user' });
  });

  it('backs off exponentially up to 15 s and formats elapsed control time', () => {
    expect([1, 2, 3, 4, 5, 6].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
  });
});

describe('ComputerPane states', () => {
  it('tells a team member why computers are unavailable, without an admin link', async () => {
    api.fetchComputerStatus.mockResolvedValue(
      status({ runtime: { state: 'unavailable', reason: 'docker_cli_missing', hardened: false } }),
    );
    await renderPane();

    expect(document.body.textContent).toContain("Your organisation hasn't enabled computers");
    expect(document.body.textContent).toContain('Bots can still chat');
    expect(document.querySelector('[data-testid="computer-open-admin"]')).toBeNull();
    // Raw precheck reasons are operator detail, not member copy.
    expect(document.body.textContent).not.toContain('docker');
  });

  it('shows a super the reason and the way to fix it', async () => {
    useAuthStore.setState({ currentUser: { id: 'u0', role: 'super', nickname: 'Admin' } as never });
    api.fetchComputerStatus.mockResolvedValue(
      status({ runtime: { state: 'unavailable', reason: 'image_missing', hardened: false } }),
    );
    await renderPane();

    expect(document.body.textContent).toContain("Computers aren't working right now");
    expect(document.body.textContent).toContain('The computer image has not been built');
    await click(document.querySelector('[data-testid="computer-open-admin"]')!);
    expect(window.location.hash).toBe('#/administration/bot-computers');
  });

  it('starts an asleep computer and then shows the live screen', async () => {
    api.fetchComputerStatus.mockResolvedValueOnce(status());
    api.startComputer.mockResolvedValue(RUNNING);
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    await renderPane();

    expect(document.body.textContent).toContain('Asleep');
    await click(document.querySelector('[data-testid="computer-start"]')!);

    expect(api.startComputer).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="computer-pane"]')?.getAttribute('data-phase')).toBe('running');
    expect(document.querySelector('[data-testid="computer-screen"]')).not.toBeNull();
  });

  it('shows the queue position while the org is full', async () => {
    api.fetchComputerStatus.mockResolvedValue(status({ state: 'absent', queue_position: 3 }));
    await renderPane();

    expect(document.body.textContent).toContain('Waiting for a free slot');
    expect(document.body.textContent).toContain('#3 in line');
  });

  it('explains an error and offers to start again', async () => {
    api.fetchComputerStatus.mockResolvedValue(status({ state: 'error', state_reason: 'oom' }));
    await renderPane();

    expect(document.body.textContent).toContain('It ran out of memory');
    expect(buttonByText('Start again')).toBeTruthy();
  });

  it('offers a retry when the status cannot be loaded', async () => {
    api.fetchComputerStatus.mockRejectedValueOnce(new Error('offline'));
    await renderPane();
    expect(document.body.textContent).toContain("Couldn't load your computer's status.");

    api.fetchComputerStatus.mockResolvedValue(status());
    await click(buttonByText('Retry'));
    expect(document.body.textContent).toContain('Asleep');
  });
});

describe('ComputerPane live screen', () => {
  it('connects view-only with a fresh token and explains clicks on the screen', async () => {
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    await renderPane();

    const rfb = latestRfb();
    expect(rfb.url).toBe('ws://greenhouse.test/api/ws/computer?token=tok-1');
    expect(rfb.options).toEqual({ shared: true });
    expect(rfb.viewOnly).toBe(true);
    expect(rfb.scaleViewport).toBe(true);
    expect(rfb.resizeSession).toBe(false);

    await act(async () => rfb.emit('connect'));
    const screen = document.querySelector('[data-testid="computer-screen"]')!;
    expect(screen.getAttribute('data-connection')).toBe('connected');

    const blocker = screen.querySelector('[aria-hidden="true"].absolute.inset-0.cursor-default')!;
    await act(async () => {
      blocker.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(screen.textContent).toContain('View only — take over to operate');
  });

  it('confirms before interrupting a busy Bot, then hands the controls to the member', async () => {
    const onFocusChange = vi.fn();
    api.fetchComputerStatus.mockResolvedValue(status({ state: 'running', last_active_at: new Date().toISOString() }));
    api.takeoverComputer.mockResolvedValue(IN_CONTROL);
    await renderPane({ onFocusChange, busyBotName: 'Sage' });

    await click(document.querySelector('[data-testid="computer-take-over"]')!);
    expect(api.takeoverComputer).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Sage is working on the computer');
    // True since take-overs are tracked: the Bot is woken on hand-back.
    expect(document.body.textContent).toContain('Sage will pick up where it left off when you hand back');

    api.fetchComputerStatus.mockResolvedValue(IN_CONTROL);
    await click(document.querySelector('[data-testid="confirm-dialog-confirm"]')!);

    expect(api.takeoverComputer).toHaveBeenCalledTimes(1);
    expect(onFocusChange).toHaveBeenCalledWith(true);
    expect(latestRfb().viewOnly).toBe(false);
    expect(document.querySelector('[data-testid="computer-hand-back"]')?.textContent).toContain('Done, hand back');
  });

  it('hands back with the note and returns to watching', async () => {
    const onFocusChange = vi.fn();
    api.fetchComputerStatus.mockResolvedValue(IN_CONTROL);
    api.handbackComputer.mockResolvedValue(RUNNING);
    await renderPane({ onFocusChange });

    const note = document.querySelector<HTMLInputElement>('input[aria-label="Note for the Bot (optional)"]')!;
    await typeInto(note, 'Signed in, code went to my phone');
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    await click(document.querySelector('[data-testid="computer-hand-back"]')!);

    expect(api.handbackComputer).toHaveBeenCalledWith({
      note: 'Signed in, code went to my phone',
      requestId: undefined,
      sessionId: undefined,
    });
    expect(onFocusChange).toHaveBeenCalledWith(false);
    expect(latestRfb().viewOnly).toBe(true);
    expect(document.querySelector('[data-testid="computer-take-over"]')).not.toBeNull();
  });

  it('types through the server, ignores IME-confirming Enter and never keeps the text', async () => {
    api.fetchComputerStatus.mockResolvedValue(IN_CONTROL);
    api.typeIntoComputer.mockResolvedValue(undefined);
    await renderPane();

    await click(buttonByText('Type text'));
    const panel = document.querySelector('[data-testid="computer-type-panel"]')!;
    const input = panel.querySelector<HTMLInputElement>('input')!;
    await typeInto(input, '你好 world');

    const composingEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    await act(async () => {
      input.dispatchEvent(composingEnter);
    });
    expect(composingEnter.defaultPrevented).toBe(true);
    expect(api.typeIntoComputer).not.toHaveBeenCalled();

    await click(panel.querySelector('[data-testid="computer-type-send"]')!);
    expect(api.typeIntoComputer).toHaveBeenCalledWith('你好 world');
    expect(input.value).toBe('');
    expect(panel.textContent).toContain('Typed');
  });

  it('sends helper keys to the remote screen while in control', async () => {
    api.fetchComputerStatus.mockResolvedValue(IN_CONTROL);
    await renderPane();

    await click(buttonByText('Type text'));
    await click(buttonByText('Enter'));
    expect(latestRfb().sentKeys).toEqual([0xff0d]);
  });

  it('falls back to a masked paste box when the clipboard cannot be read', async () => {
    api.fetchComputerStatus.mockResolvedValue(IN_CONTROL);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: () => Promise.reject(new Error('denied')) },
    });
    await renderPane();

    await click(buttonByText('Paste'));
    const panel = document.querySelector('[data-testid="computer-type-panel"]')!;
    expect(panel.querySelector('input')?.type).toBe('password');
    expect(panel.textContent).toContain("didn't allow reading the clipboard");
    expect(api.typeIntoComputer).not.toHaveBeenCalled();
  });

  it('reconnects with a fresh token after the socket drops', async () => {
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    await renderPane();
    const first = latestRfb();
    await act(async () => first.emit('connect'));

    api.createComputerViewToken.mockResolvedValue({ token: 'tok-2', expires_at: new Date().toISOString() });
    await act(async () => first.emit('disconnect', { clean: false }));
    expect(document.querySelector('[data-testid="computer-screen"]')?.getAttribute('data-connection')).toBe(
      'reconnecting',
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(1) + 50));
    });
    await flush();
    expect(fakes.FakeRfb.instances).toHaveLength(2);
    expect(latestRfb().url).toContain('token=tok-2');
  });

  it('follows bots:computer pushes', async () => {
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    await renderPane();
    expect(latestRfb().viewOnly).toBe(true);

    api.fetchComputerStatus.mockResolvedValue(IN_CONTROL);
    await act(async () => {
      for (const handler of fakes.wsHandlers) handler({ type: 'bots:computer', state: 'running', controller: 'user' });
    });
    await flush();
    expect(latestRfb().viewOnly).toBe(false);
  });
});

describe('ComputerPane needs-you shortcut', () => {
  const request: BotRequestView = {
    id: 'brq_1',
    session_id: 'sess-1',
    bot_id: 'bot_sage',
    kind: 'takeover',
    status: 'pending',
    payload: { reason: 'Solve the CAPTCHA on example.com', kind: 'captcha', url: 'https://example.com/login' },
    result: null,
    expires_at: null,
    created_at: new Date().toISOString(),
  };

  it("offers the conversation's pending request and answers it on take over", async () => {
    api.fetchComputerStatus.mockResolvedValue(status({ state: 'running', last_active_at: new Date().toISOString() }));
    api.listRequests.mockResolvedValue({ requests: [request] });
    api.listBots.mockResolvedValue({
      bots: [{ id: 'bot_sage', name: 'Sage', status: 'active' }],
      archived_bots: [],
      computer: RUNNING.runtime,
      vault_available: true,
      pending_requests: 1,
    });
    api.takeoverComputer.mockResolvedValue(IN_CONTROL);
    await renderPane({ sessionId: 'sess-1' });

    const banner = document.querySelector('[data-testid="computer-needs-you"]')!;
    expect(banner.textContent).toContain('Sage needs you');
    expect(banner.textContent).toContain('Solve the CAPTCHA on example.com');

    // The Bot asked and is waiting — no "interrupt the Bot?" confirmation.
    api.fetchComputerStatus.mockResolvedValue(IN_CONTROL);
    await click(banner.querySelector('button')!);
    expect(api.takeoverComputer).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="computer-needs-you"]')).toBeNull();

    // Handing back settles exactly the request that was answered.
    api.handbackComputer.mockResolvedValue(RUNNING);
    await click(document.querySelector('[data-testid="computer-hand-back"]')!);
    expect(api.handbackComputer).toHaveBeenCalledWith({ note: '', requestId: 'brq_1', sessionId: 'sess-1' });
  });

  it('names the conversation on a voluntary hand-back, so its single waiting card is answered', async () => {
    // The member took over from the header (no card in hand) and a Bot is
    // waiting on the computer in this conversation: the server settles that
    // card from `session_id` and wakes the Bot.
    api.fetchComputerStatus.mockResolvedValue(IN_CONTROL);
    api.handbackComputer.mockResolvedValue(RUNNING);
    await renderPane({ sessionId: 'sess-1' });

    await click(document.querySelector('[data-testid="computer-hand-back"]')!);
    expect(api.handbackComputer).toHaveBeenCalledWith({ note: '', requestId: undefined, sessionId: 'sess-1' });
  });

  it('explains a card the computer raised itself and lets the Bot continue from the banner', async () => {
    // The member took over mid-action, then the lease went back (viewer closed):
    // the implicit card still waits, and its `reason` is a code, not words.
    const implicit: BotRequestView = {
      ...request,
      id: 'brq_9',
      payload: { implicit: true, reason: 'interrupted', host: 'example.com' } as unknown as BotRequestView['payload'],
    };
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    api.listRequests.mockResolvedValue({ requests: [implicit] });
    api.listBots.mockResolvedValue({
      bots: [{ id: 'bot_sage', name: 'Sage', status: 'active' }],
      archived_bots: [],
      computer: RUNNING.runtime,
      vault_available: true,
      pending_requests: 1,
    });
    api.handbackComputer.mockResolvedValue(RUNNING);
    await renderPane({ sessionId: 'sess-1' });

    const banner = document.querySelector('[data-testid="computer-needs-you"]')!;
    expect(banner.textContent).toContain('You took over while Sage was working');
    expect(banner.textContent).not.toContain('interrupted');
    await click(buttonByText('Hand back — let Sage continue'));
    expect(api.takeoverComputer).not.toHaveBeenCalled();
    expect(api.handbackComputer).toHaveBeenCalledWith({ note: '', requestId: 'brq_9', sessionId: 'sess-1' });
  });

  it('asks to hand back before closing while in control', async () => {
    const onClose = vi.fn();
    api.fetchComputerStatus.mockResolvedValue(IN_CONTROL);
    api.handbackComputer.mockResolvedValue(RUNNING);
    await renderPane({ onClose });

    await click(document.querySelector('button[aria-label="Close computer panel"]')!);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Hand back before closing?');

    await click(document.querySelector('[data-testid="confirm-dialog-confirm"]')!);
    expect(api.handbackComputer).toHaveBeenCalledWith({ note: '', requestId: undefined, sessionId: undefined });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing and opens no connection while closed', async () => {
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    await renderPane({ open: false });
    expect(document.querySelector('[data-testid="computer-pane"]')).toBeNull();
    expect(api.fetchComputerStatus).not.toHaveBeenCalled();
    expect(fakes.FakeRfb.instances).toHaveLength(0);
  });
});

describe('ComputerPane error copy', () => {
  it("explains a refused take-over in the member's words, from the server's code", async () => {
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    api.takeoverComputer.mockRejectedValueOnce(new BotsApiError('Already in control', 409, 'user_in_control'));
    await renderPane();

    await click(document.querySelector('[data-testid="computer-take-over"]')!);
    expect(document.body.textContent).toContain("You're already in control of the computer.");
  });

  it("tells the server's full disk apart from the computer's own", async () => {
    // over_quota + reason host_disk: the Docker host refuses every start — an
    // admin's job; without the reason it is the member's own home.
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    api.takeoverComputer.mockRejectedValueOnce(new BotsApiError('Low disk', 409, 'over_quota', 'host_disk'));
    await renderPane();
    await click(document.querySelector('[data-testid="computer-take-over"]')!);
    expect(document.body.textContent).toContain('The server is almost out of disk space');
    expect(document.body.textContent).not.toContain("The computer's disk is full");

    api.takeoverComputer.mockRejectedValueOnce(new BotsApiError('Full', 409, 'over_quota'));
    await click(document.querySelector('[data-testid="computer-take-over"]')!);
    expect(document.body.textContent).toContain(
      "The computer's disk is full. Open it to clear Downloads, or reset it.",
    );
  });

  it('never reads an Object.prototype name as a known code', async () => {
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    api.takeoverComputer.mockRejectedValueOnce(new BotsApiError('boom', 500, 'constructor'));
    await renderPane();

    await click(document.querySelector('[data-testid="computer-take-over"]')!);
    expect(document.body.textContent).toContain("Couldn't take over the computer.");
  });

  it("falls back to the action's own line for a code it does not know", async () => {
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    api.takeoverComputer.mockRejectedValueOnce(new BotsApiError('boom', 500, 'something_new'));
    await renderPane();

    await click(document.querySelector('[data-testid="computer-take-over"]')!);
    expect(document.body.textContent).toContain("Couldn't take over the computer.");
    expect(document.body.textContent).not.toContain('boom');
  });
});

describe('ComputerPane close guard (host-driven)', () => {
  it('closes at once when the member is only watching', async () => {
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    const handle = { current: null as ComputerPaneHandle | null };
    await renderPane({}, handle);

    const closed = vi.fn();
    await act(async () => handle.current?.requestClose(closed));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
  });

  it('asks before a header toggle closes the pane while the member holds control, then hands back first', async () => {
    api.fetchComputerStatus.mockResolvedValue(IN_CONTROL);
    api.handbackComputer.mockResolvedValue(RUNNING);
    const handle = { current: null as ComputerPaneHandle | null };
    await renderPane({}, handle);

    const closed = vi.fn();
    await act(async () => handle.current?.requestClose(closed));
    await flush();
    expect(closed).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Hand back before closing?');

    await click(document.querySelector('[data-testid="confirm-dialog-confirm"]')!);
    expect(api.handbackComputer).toHaveBeenCalledWith({ note: '', requestId: undefined, sessionId: undefined });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('keeps the pane (and control) when handing back fails', async () => {
    api.fetchComputerStatus.mockResolvedValue(IN_CONTROL);
    api.handbackComputer.mockRejectedValueOnce(new BotsApiError('nope', 500));
    const handle = { current: null as ComputerPaneHandle | null };
    await renderPane({}, handle);

    const closed = vi.fn();
    await act(async () => handle.current?.requestClose(closed));
    await flush();
    await click(document.querySelector('[data-testid="confirm-dialog-confirm"]')!);
    expect(closed).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Couldn't hand the computer back.");
  });
});

describe('ComputerPane with a host-owned status', () => {
  /** What the Bots page does: one useComputerStatus feeding its header dot and the pane. */
  function Host({ onHeader }: { onHeader: (state: ComputerStatusState) => void }) {
    const computer = useComputerStatus(true);
    onHeader(computer);
    return createElement('div', null, [
      createElement('span', { key: 'dot', 'data-testid': 'header-phase' }, computer.phase?.kind ?? 'loading'),
      createElement('span', { key: 'ctl', 'data-testid': 'header-controller' }, computer.status?.controller ?? ''),
      createElement(ComputerPane, { key: 'pane', open: true, onClose: vi.fn(), computer }),
    ]);
  }

  async function renderHost() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(I18nProvider, { initialLocale: 'en', children: createElement(Host, { onHeader: () => {} }) }),
      );
    });
    await flush();
  }

  it('reads one status: a push costs one fetch, not one per consumer', async () => {
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    await renderHost();
    expect(api.fetchComputerStatus).toHaveBeenCalledTimes(1);
    expect(fakes.wsHandlers.size).toBe(1);

    await act(async () => {
      for (const handler of fakes.wsHandlers) handler({ type: 'bots:computer', state: 'running', controller: 'bot' });
    });
    await flush();
    expect(api.fetchComputerStatus).toHaveBeenCalledTimes(2);
  });

  it("shows an action's result in the header and the pane at once, with no push (socket down)", async () => {
    api.fetchComputerStatus.mockResolvedValue(RUNNING);
    api.takeoverComputer.mockResolvedValue(IN_CONTROL);
    await renderHost();

    await click(document.querySelector('[data-testid="computer-take-over"]')!);
    expect(document.querySelector('[data-testid="header-phase"]')?.textContent).toBe('running');
    expect(document.querySelector('[data-testid="header-controller"]')?.textContent).toBe('user');
    expect(document.querySelector('[data-testid="computer-pane"]')?.getAttribute('data-phase')).toBe('running');
    expect(document.querySelector('[data-testid="computer-hand-back"]')).not.toBeNull();
  });
});
