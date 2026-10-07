/** @vitest-environment happy-dom */

/**
 * The computer's terminal against a fake xterm and a fake socket: the wire
 * protocol (binary keystrokes, a JSON resize on connect and on every fit, raw
 * output written as bytes), reconnecting with a fresh ticket, the 4-terminal
 * cap, and the pause in a background tab.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { ComputerTerminal, resizeFrame } from './computer-terminal';
import { backoffDelay } from './computer-screen';

const fakes = vi.hoisted(() => {
  type Listener<T> = (value: T) => void;
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    cols = 80;
    rows = 24;
    written: Array<string | Uint8Array> = [];
    disposed = false;
    host: HTMLElement | null = null;
    private data: Array<Listener<string>> = [];
    private binary: Array<Listener<string>> = [];
    private resized: Array<Listener<{ cols: number; rows: number }>> = [];
    constructor(public options: Record<string, unknown>) {
      FakeTerminal.instances.push(this);
    }
    loadAddon(addon: { activate: (term: FakeTerminal) => void }) {
      addon.activate(this);
    }
    open(host: HTMLElement) {
      this.host = host;
    }
    onData(listener: Listener<string>) {
      this.data.push(listener);
      return { dispose: () => {} };
    }
    onBinary(listener: Listener<string>) {
      this.binary.push(listener);
      return { dispose: () => {} };
    }
    onResize(listener: Listener<{ cols: number; rows: number }>) {
      this.resized.push(listener);
      return { dispose: () => {} };
    }
    write(data: string | Uint8Array) {
      this.written.push(data);
    }
    focus() {}
    dispose() {
      this.disposed = true;
    }
    /** What xterm does when the member types. */
    type(text: string) {
      this.data.forEach((listener) => listener(text));
    }
    /** What a fit to a new size does. */
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.resized.forEach((listener) => listener({ cols, rows }));
    }
  }
  class FakeFitAddon {
    fits = 0;
    activate() {}
    fit() {
      this.fits += 1;
    }
    dispose() {}
  }
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    readyState = 0;
    binaryType = 'blob';
    sent: Array<string | Uint8Array> = [];
    closedWith: number | null = null;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(public url: string) {
      FakeWebSocket.instances.push(this);
    }
    send(data: string | Uint8Array) {
      this.sent.push(data);
    }
    close(code = 1000) {
      this.readyState = 3;
      this.closedWith = code;
    }
    /** The server accepted the ticket. */
    accept() {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }
    receive(data: unknown) {
      this.onmessage?.({ data });
    }
    /** The server (or the network) closed it. */
    drop(code: number, reason = '') {
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
  }
  return { FakeTerminal, FakeFitAddon, FakeWebSocket };
});

const api = vi.hoisted(() => ({
  createComputerTerminalToken: vi.fn(),
  computerTerminalUrl: (token: string) => `ws://greenhouse.test/api/ws/computer-terminal?token=${token}`,
}));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));
vi.mock('../../lib/xterm/loader', () => ({
  loadXterm: async () => ({ Terminal: fakes.FakeTerminal, FitAddon: fakes.FakeFitAddon }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let tickets = 0;

async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderTerminal(props: { active?: boolean; onDisconnected?: () => void } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ComputerTerminal, {
          active: props.active ?? true,
          onDisconnected: props.onDisconnected,
        }),
      }),
    );
  });
  await flush();
}

const terminal = () => fakes.FakeTerminal.instances.at(-1)!;
const socket = () => fakes.FakeWebSocket.instances.at(-1)!;
const connection = () => document.querySelector('[data-testid="computer-terminal"]')?.getAttribute('data-connection');
const bytes = (data: string | Uint8Array | undefined) => (data instanceof Uint8Array ? Array.from(data) : data);

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  fakes.FakeTerminal.instances.length = 0;
  fakes.FakeWebSocket.instances.length = 0;
  tickets = 0;
  api.createComputerTerminalToken.mockReset();
  api.createComputerTerminalToken.mockImplementation(async () => ({
    token: `term-${++tickets}`,
    expires_at: new Date().toISOString(),
  }));
  vi.stubGlobal('WebSocket', fakes.FakeWebSocket);
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('ComputerTerminal', () => {
  it('connects with a terminal ticket, says its size, sends keystrokes as bytes and writes what comes back', async () => {
    await renderTerminal();
    expect(api.createComputerTerminalToken).toHaveBeenCalledTimes(1);
    expect(socket().url).toBe('ws://greenhouse.test/api/ws/computer-terminal?token=term-1');
    expect(socket().binaryType).toBe('arraybuffer');
    expect(connection()).toBe('connecting');

    await act(async () => socket().accept());
    expect(connection()).toBe('connected');
    expect(socket().sent).toEqual([resizeFrame(80, 24)]);

    await act(async () => terminal().type('ls -la\r'));
    expect(bytes(socket().sent[1])).toEqual([...new TextEncoder().encode('ls -la\r')]);
    // Not ASCII-only: a Chinese file name goes up as UTF-8.
    await act(async () => terminal().type('报告'));
    expect(bytes(socket().sent[2])).toEqual([...new TextEncoder().encode('报告')]);

    await act(async () => socket().receive(new Uint8Array([0x68, 0x69]).buffer));
    expect(bytes(terminal().written[0])).toEqual([0x68, 0x69]);

    await act(async () => terminal().resize(120, 40));
    expect(socket().sent.at(-1)).toBe('{"type":"resize","cols":120,"rows":40}');
  });

  it('follows the design tokens and keeps ANSI colours readable on a light background', async () => {
    await renderTerminal();
    expect(terminal().options).toMatchObject({ minimumContrastRatio: 4.5, theme: expect.any(Object) });
    expect(terminal().host?.closest('[data-testid="computer-terminal"]')).not.toBeNull();
  });

  it('reconnects with a fresh ticket after the socket drops', async () => {
    const onDisconnected = vi.fn();
    await renderTerminal({ onDisconnected });
    await act(async () => socket().accept());

    await act(async () => socket().drop(1011, 'tunnel closed'));
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(connection()).toBe('reconnecting');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(1) + 50));
    });
    await flush();
    expect(fakes.FakeWebSocket.instances).toHaveLength(2);
    expect(socket().url).toContain('token=term-2');
    // The same terminal (and its scrollback) carries on.
    expect(fakes.FakeTerminal.instances).toHaveLength(1);
  });

  it('waits for the member when a fifth terminal is refused, then reconnects on request', async () => {
    await renderTerminal();
    await act(async () => socket().drop(4009, 'too_many'));
    expect(connection()).toBe('too_many');
    expect(document.body.textContent).toContain('Too many terminals are open (at most 4)');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(1) + 50));
    });
    expect(fakes.FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      document
        .querySelector('[data-testid="computer-terminal-reconnect"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(fakes.FakeWebSocket.instances).toHaveLength(2);
    expect(socket().url).toContain('token=term-2');
  });

  it('stops retrying when Bots are switched off for the member (4003)', async () => {
    await renderTerminal();
    await act(async () => socket().drop(4003, 'forbidden'));
    expect(connection()).toBe('failed');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(1) + 50));
    });
    expect(fakes.FakeWebSocket.instances).toHaveLength(1);
  });

  it('refetches a ticket after a stale one (4001) and after the shell exited (1011)', async () => {
    await renderTerminal();
    await act(async () => socket().drop(4001, 'stale ticket'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(1) + 50));
    });
    await flush();
    expect(fakes.FakeWebSocket.instances).toHaveLength(2);
    expect(socket().url).toContain('token=term-2');
    await act(async () => socket().accept());

    await act(async () => socket().drop(1011, 'terminal closed'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(1) + 50));
    });
    await flush();
    expect(fakes.FakeWebSocket.instances).toHaveLength(3);
    expect(socket().url).toContain('token=term-3');
  });

  it('disconnects after a minute in a background tab and reconnects on return', async () => {
    await renderTerminal();
    const first = socket();
    await act(async () => first.accept());

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => setVisibility('hidden'));
    await act(async () => {
      vi.advanceTimersByTime(59_000);
    });
    expect(first.closedWith).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1_500);
    });
    vi.useRealTimers();
    expect(first.closedWith).toBe(1000);
    expect(connection()).toBe('paused');

    await act(async () => setVisibility('visible'));
    await flush();
    expect(fakes.FakeWebSocket.instances).toHaveLength(2);
    expect(socket().url).toContain('token=term-2');
  });

  it('closes its socket and disposes the terminal when it goes away', async () => {
    await renderTerminal();
    await act(async () => socket().accept());
    await act(async () => root?.unmount());
    root = null;
    expect(socket().closedWith).toBe(1000);
    expect(terminal().disposed).toBe(true);
  });
});
