/**
 * access.ts against a fake runtime and a fake Playwright: one DevTools
 * connection per member per process, even when callers race a stale or
 * failing connection (the relay accepts a single client, so a second
 * connection would kick the first mid-action), take-over aborts reaching
 * every tracked action, and file paths that could forge stderr lines.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectOverCDP, ensureRunning, exec, cdpLock, expireForeign } = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
  ensureRunning: vi.fn(),
  exec: vi.fn(),
  /** The DevTools-owner lock as the database answers it (true = this process owns it). */
  cdpLock: {
    tryLockCdpOwner: vi.fn(async (_userId: string) => true),
    unlockCdpOwner: vi.fn(async () => {}),
    setCdpWanted: vi.fn(async () => {}),
    isCdpWanted: vi.fn(async () => false),
  },
  expireForeign: vi.fn(),
}));

vi.mock('playwright-core', () => ({ chromium: { connectOverCDP } }));
vi.mock('./cdp-bridge.js', () => ({
  openCdpBridge: async () => ({ url: 'ws://127.0.0.1:1/devtools/browser/x', close: async () => {} }),
}));
vi.mock('./runtime.js', () => ({
  requireComputerRuntime: () => ({
    controller: { ensureRunning, markBroken: vi.fn() },
    host: { exec, execStream: vi.fn() },
    config: { proxy: null },
  }),
}));
vi.mock('@greenhouse/db', () => ({
  getDb: () => ({ botComputers: { touch: async () => {}, get: async () => undefined, ...cdpLock } }),
}));
vi.mock('./tab-leases.js', () => ({ leaseRegistryFor: () => ({ expireForeign }) }));

import {
  abortComputerActions,
  ComputerActionsAbortedError,
  getBrowser,
  onComputerActionsAborted,
  readComputerFile,
  trackComputerAction,
  ComputerUnavailableError,
} from './access.js';

function fakeBrowser(name: string) {
  return { name, isConnected: () => true, on: vi.fn(), close: vi.fn(async () => {}), contexts: () => [] };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  connectOverCDP.mockReset();
  ensureRunning.mockReset();
  exec.mockReset();
  cdpLock.tryLockCdpOwner.mockReset().mockResolvedValue(true);
  expireForeign.mockReset();
});

describe('getBrowser', () => {
  it('reconnects once when callers were waiting on a connection that failed', async () => {
    ensureRunning.mockResolvedValue({ container_name: 'c-fail', last_started_at: 't1' });
    let rejectFirst!: (err: Error) => void;
    connectOverCDP
      .mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)))
      .mockResolvedValue(fakeBrowser('second'));

    const first = getBrowser('u-fail').catch((err: unknown) => err);
    await flush();
    const b = getBrowser('u-fail');
    const c = getBrowser('u-fail');
    await flush();
    rejectFirst(new Error('relay busy'));

    expect(await first).toBeInstanceOf(ComputerUnavailableError);
    const [browserB, browserC] = await Promise.all([b, c]);
    expect(browserB).toBe(browserC);
    expect(connectOverCDP).toHaveBeenCalledTimes(2); // the failed connect + exactly one reconnect
  });

  it('replaces a stale connection once when two callers notice it in the same tick', async () => {
    ensureRunning.mockResolvedValue({ container_name: 'c-stale', last_started_at: 't0' });
    connectOverCDP.mockResolvedValueOnce(fakeBrowser('old')).mockResolvedValue(fakeBrowser('new'));
    const old = await getBrowser('u-stale');

    // The other slot restarted the computer: same container name, new start time.
    ensureRunning.mockResolvedValue({ container_name: 'c-stale', last_started_at: 't1' });
    const [b, c] = await Promise.all([getBrowser('u-stale'), getBrowser('u-stale')]);
    expect(b).toBe(c);
    expect(b).not.toBe(old);
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
  });
});

describe('DevTools ownership', () => {
  it('claims the browser before connecting, and disposes leftover contexts on a claim new to this process', async () => {
    ensureRunning.mockResolvedValue({ container_name: 'c-own', last_started_at: 't1' });
    const order: string[] = [];
    cdpLock.tryLockCdpOwner.mockImplementation(async () => {
      order.push('claim');
      return true;
    });
    connectOverCDP.mockImplementation(async () => {
      order.push('connect');
      return fakeBrowser('owned');
    });
    await getBrowser('u-own');
    expect(order).toEqual(['claim', 'connect']);
    expect(expireForeign).toHaveBeenCalledTimes(1);

    // The cached connection needs no claim; a reconnect re-checks but is not fresh.
    await getBrowser('u-own');
    expect(cdpLock.tryLockCdpOwner).toHaveBeenCalledTimes(1);
    ensureRunning.mockResolvedValue({ container_name: 'c-own', last_started_at: 't2' });
    await getBrowser('u-own');
    expect(cdpLock.tryLockCdpOwner).toHaveBeenCalledTimes(2);
    expect(expireForeign).toHaveBeenCalledTimes(1);
  });

  it('never connects while another process owns the browser: busy after a bounded wait', async () => {
    vi.useFakeTimers();
    try {
      ensureRunning.mockResolvedValue({ container_name: 'c-busy', last_started_at: 't1' });
      cdpLock.tryLockCdpOwner.mockResolvedValue(false);
      const result = getBrowser('u-busy').catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(await result).toMatchObject({ code: 'busy' });
      expect(connectOverCDP).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('take-over aborts', () => {
  it('aborts every tracked action (reason: take-over) and tells subscribers', () => {
    const seen: Array<[string, string]> = [];
    const stop = onComputerActionsAborted((userId, reason) => seen.push([userId, reason]));
    const turn = new AbortController();
    const action = trackComputerAction('u-abort', turn.signal);
    const other = trackComputerAction('someone-else');

    expect(abortComputerActions('u-abort')).toBe(1);
    expect(action.signal.aborted).toBe(true);
    expect(action.signal.reason).toBeInstanceOf(ComputerActionsAbortedError);
    expect(action.signal.reason).toMatchObject({ name: 'AbortError', reason: 'takeover' });
    expect((action.signal.reason as ComputerActionsAbortedError).toUnavailable()).toMatchObject({
      code: 'user_in_control',
    });
    expect(other.signal.aborted).toBe(false);
    expect(seen).toEqual([['u-abort', 'takeover']]);

    // done() untracks: a later take-over finds nothing to abort.
    action.done();
    expect(abortComputerActions('u-abort', 'purge')).toBe(0);
    expect(seen).toEqual([
      ['u-abort', 'takeover'],
      ['u-abort', 'purge'],
    ]);
    other.done();
    stop();
  });
});

describe('file paths', () => {
  it('refuses control characters, so a path cannot forge lines in the command output', async () => {
    ensureRunning.mockResolvedValue({ container_name: 'c-files', last_started_at: 't1' });
    for (const path of ['a\nError: x is not running', 'tab\there', 'bell\u0007', 'del\u007f']) {
      await expect(readComputerFile('u-files', path, { maxBytes: 10 })).rejects.toMatchObject({
        message: 'Invalid file path',
      });
    }
    expect(exec).not.toHaveBeenCalled();
    expect(ensureRunning).not.toHaveBeenCalled();
  });
});
