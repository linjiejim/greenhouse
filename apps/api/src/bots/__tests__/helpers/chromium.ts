/**
 * A real Chromium for browser-adapter tests, connected the way production
 * connects to the computer: `chromium.connectOverCDP(…, {noDefaults:true})`
 * against a separately running browser with a persistent profile, so the
 * default context, CDP window creation and re-adoption behave as they do on
 * the computer. Uses the Playwright-managed headless shell (or Chrome for
 * Testing). These suites prove the vault's and the snapshot's security
 * properties, so in CI a missing browser FAILS the run instead of skipping
 * it — the CI `test` job installs it with
 * `pnpm exec playwright install --with-deps --only-shell chromium`. Locally
 * (no `CI`) the suites skip when no browser is installed. An overlay whose CI
 * cannot install a browser opts out explicitly with BOTS_BROWSER_TESTS=skip.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { trackComputerAction, type ComputerLease } from '../../computer/access.js';
import type { ComputerDeps, StoredScreenshot } from '../../computer/browser-session.js';

/**
 * The Playwright headless-shell build next to the managed Chromium. Preferred:
 * Chrome for Testing's new headless mode on macOS never produces frames for a
 * browser launched outside Playwright (requestAnimationFrame never fires, so
 * clicks wait forever for "stable" and screenshots time out), while the shell
 * renders normally — like the computer's headful Chromium under Xvnc does.
 */
function executable(): string | null {
  let full: string;
  try {
    full = chromium.executablePath();
  } catch {
    return null;
  }
  const match = /^(.*)[/\\]chromium-(\d+)[/\\]/.exec(full);
  if (match) {
    const root = join(match[1]!, `chromium_headless_shell-${match[2]}`);
    if (existsSync(root)) {
      // chrome-headless-shell-<platform>/chrome-headless-shell (CfT builds),
      // chrome-linux/headless_shell (linux-arm64).
      const names =
        process.platform === 'win32' ? ['chrome-headless-shell.exe'] : ['chrome-headless-shell', 'headless_shell'];
      for (const dir of readdirSync(root)) {
        for (const name of names) {
          const shell = join(root, dir, name);
          if (existsSync(shell)) return shell;
        }
      }
    }
  }
  return existsSync(full) ? full : null;
}

export function chromiumAvailable(): boolean {
  if (executable() !== null) return true;
  if (process.env.CI && process.env.BOTS_BROWSER_TESTS !== 'skip') {
    throw new Error(
      'The Bots browser suites (vault fills, snapshot masking, BrowserSession, tab leases) need a Chromium in CI: ' +
        'run `pnpm exec playwright install --with-deps --only-shell chromium` (or set BOTS_BROWSER_TESTS=skip to skip them on purpose).',
    );
  }
  return false;
}

export interface TestChromium {
  wsEndpoint: string;
  browser: Browser;
  /** A second, independent connection (simulates an API restart / reconnect). */
  reconnect(): Promise<Browser>;
  close(): Promise<void>;
}

export async function launchTestChromium(): Promise<TestChromium> {
  const profile = mkdtempSync(join(tmpdir(), 'gh-bots-chromium-'));
  const exe = executable();
  if (!exe) throw new Error('Playwright Chromium is not installed');
  const proc: ChildProcess = spawn(
    exe,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--password-store=basic',
      '--use-mock-keychain',
      // The computer's anti-throttle switches (apps/bot-computer gh-computer):
      // without them a window that is not in front stops rendering.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      // CI runners (ubuntu 24.04) forbid the unprivileged user namespaces the
      // sandbox needs; Playwright's own launcher passes the same switch.
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const wsEndpoint = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`Chromium did not start: ${buffer.slice(-500)}`)), 20_000);
    proc.stderr?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited early (${code}): ${buffer.slice(-500)}`));
    });
  });
  const connections: Browser[] = [];
  const connect = async () => {
    const browser = await chromium.connectOverCDP(wsEndpoint, { noDefaults: true });
    connections.push(browser);
    return browser;
  };
  const browser = await connect();
  return {
    wsEndpoint,
    browser,
    reconnect: connect,
    async close() {
      for (const connection of connections) await connection.close().catch(() => undefined);
      const exited = new Promise<void>((resolve) => {
        if (proc.exitCode !== null) resolve();
        else proc.once('exit', () => resolve());
      });
      proc.kill('SIGKILL');
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export interface FakeComputer {
  deps: ComputerDeps;
  lease: ComputerLease;
  remembered: string[];
  screenshots: Buffer[];
  /** Where each screenshot was stored (conversation + member). */
  screenshotOwners: Array<{ userId: string; sessionId: string }>;
  /** Swap the browser connection deps hand out (e.g. after a reconnect). */
  useBrowser(browser: Browser): void;
}

/**
 * ComputerDeps over a test browser: an in-memory take-over lease, an
 * in-memory redaction set that mirrors access.ts semantics (exact values →
 * [REDACTED]), a screenshot sink that hands out chat-file shaped results, and
 * the real in-process action tracker (so `abortComputerActions` simulates a
 * take-over in this process).
 */
export function fakeComputer(browser: Browser, overrides: Partial<ComputerDeps> = {}): FakeComputer {
  let current = browser;
  const state: FakeComputer = {
    lease: { controller: 'bot', epoch: 0 },
    remembered: [],
    screenshots: [],
    screenshotOwners: [],
    useBrowser: (next) => {
      current = next;
    },
    deps: {
      getBrowser: async () => current,
      ensureReady: async () => undefined,
      trackAction: (userId, signal) => trackComputerAction(userId, signal),
      currentLease: async () => ({ ...state.lease }),
      touch: async () => undefined,
      remember: (_userId, value) => {
        state.remembered.push(value);
      },
      redact: (_userId, text) => state.remembered.reduce((out, value) => out.split(value).join('[REDACTED]'), text),
      isRunning: async () => true,
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }),
      readFile: async () => Buffer.alloc(0),
      writeFile: async () => undefined,
      storeScreenshot: async (png, owner): Promise<StoredScreenshot> => {
        state.screenshots.push(png);
        state.screenshotOwners.push({ userId: owner.userId, sessionId: owner.sessionId });
        const id = `cf_shot_${state.screenshots.length}`;
        return { file_id: id, name: 'screenshot.png', size: png.length, download_url: `/api/chat-files/${id}/content` };
      },
      // No gh-jobs on a test browser: suites that need processes override these.
      startJob: async () => {
        throw new Error('no background processes in this test');
      },
      listJobs: async () => [],
      jobLog: async () => {
        throw new Error('no background processes in this test');
      },
      stopJob: async (_userId, id) => ({ id, stopped: false }),
      ...overrides,
    },
  };
  return state;
}
