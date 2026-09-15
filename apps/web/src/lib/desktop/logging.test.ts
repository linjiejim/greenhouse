import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A packaged app has no devtools and, before this, its log file contained nothing
 * from the webview — which is precisely why a login hang was invisible. These tests
 * pin the forwarding contract so it can't silently regress.
 */

const invokeDesktop = vi.fn(() => Promise.resolve(null));
vi.mock('./bridge', () => ({
  isDesktop: () => Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__),
  invokeDesktop,
}));

let initDesktopLogging: typeof import('./logging').initDesktopLogging;
const listeners = new Map<string, (event: unknown) => void>();
// Captured before any patching so a failing test can't leak a patched console into
// the next one — that cascade made an unrelated test fail while debugging this.
const pristineConsole = { warn: console.warn, error: console.error };

beforeEach(async () => {
  invokeDesktop.mockClear();
  listeners.clear();
  console.warn = pristineConsole.warn;
  console.error = pristineConsole.error;
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {},
    addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  vi.resetModules();
  ({ initDesktopLogging } = await import('./logging'));
});

afterEach(() => {
  console.warn = pristineConsole.warn;
  console.error = pristineConsole.error;
  delete (globalThis as { window?: unknown }).window;
});

describe('desktop log forwarding', () => {
  it('sends console.error to the shell log', () => {
    const stop = initDesktopLogging();
    console.error('boom', { code: 42 });
    stop();

    expect(invokeDesktop).toHaveBeenCalledWith('desktop_log', {
      level: 'error',
      message: 'boom {"code":42}',
    });
  });

  it('keeps the original console behaviour intact', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = initDesktopLogging();
    console.warn('still visible');
    stop();

    expect(spy).toHaveBeenCalledWith('still visible');
    spy.mockRestore();
  });

  it('captures uncaught errors and unhandled rejections', () => {
    // The two failure modes that produce a stuck UI with nothing on screen.
    const stop = initDesktopLogging();

    listeners.get('error')?.({ message: 'kaboom', filename: 'app.js', lineno: 12 });
    expect(invokeDesktop).toHaveBeenCalledWith('desktop_log', {
      level: 'error',
      message: 'uncaught: kaboom (app.js:12)',
    });

    invokeDesktop.mockClear();
    listeners.get('unhandledrejection')?.({ reason: new TypeError('Load failed') });
    expect(invokeDesktop).toHaveBeenCalledWith('desktop_log', {
      level: 'error',
      message: 'unhandled rejection: Load failed',
    });

    stop();
  });

  it('formats Errors without dumping a stack, and survives cyclic objects', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const stop = initDesktopLogging();
    console.error(new RangeError('too big'), cyclic);
    stop();

    const [, payload] = invokeDesktop.mock.calls[0] as unknown as [string, { message: string }];
    expect(payload.message).toContain('RangeError: too big');
    expect(payload.message).toContain('[object Object]');
  });

  it('restores the console on teardown so listeners do not stack up', () => {
    const before = console.error;
    const stop = initDesktopLogging();
    expect(console.error).not.toBe(before);
    stop();
    expect(console.error).toBe(before);
    expect(listeners.size).toBe(0);
  });

  it('does nothing in a plain browser', () => {
    (globalThis as { window?: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
    const before = console.error;
    const stop = initDesktopLogging();

    console.error('browser only');
    expect(invokeDesktop).not.toHaveBeenCalled();
    expect(console.error).toBe(before);
    stop();
  });
});
