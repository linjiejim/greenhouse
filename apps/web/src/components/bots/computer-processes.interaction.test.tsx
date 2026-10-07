/** @vitest-environment happy-dom */

/**
 * The computer's Processes tab with a mocked API: the empty state that says
 * how jobs get here, the list (status, exit code, start), the log viewer that
 * refreshes every 3 s while its job runs (and once more when it ends), and
 * Stop behind a confirmation.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputerProcessView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { BotsApiError } from '../../lib/api/bots';
import { ToastContainer } from '../ui';
import { ComputerProcesses, PROCESS_REFRESH_MS, readableLog } from './computer-processes';

const api = vi.hoisted(() => ({
  listComputerProcesses: vi.fn(),
  fetchComputerProcessLog: vi.fn(),
  stopComputerProcess: vi.fn(),
}));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function job(overrides: Partial<ComputerProcessView>): ComputerProcessView {
  return {
    id: 'j00000001',
    name: 'build',
    command: 'npm run build',
    cwd: '/home/agent/work',
    status: 'running',
    exit_code: null,
    started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    ended_at: null,
    log_bytes: 120,
    ...overrides,
  };
}

const BUILD = job({});
const FETCH = job({ id: 'j00000002', name: 'fetch', command: 'python fetch.py', status: 'exited', exit_code: 0 });
const LINT = job({ id: 'j00000003', name: 'lint', command: 'npm run lint', status: 'exited', exit_code: 2 });
const CRAWL = job({ id: 'j00000004', name: 'crawl', command: 'python crawl.py', status: 'lost' });

let root: ReturnType<typeof createRoot> | null = null;

async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderProcesses(props: { active?: boolean; onStale?: () => void } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: [
          createElement(ComputerProcesses, { key: 'p', active: props.active ?? true, onStale: props.onStale }),
          createElement(ToastContainer, { key: 'toasts' }),
        ],
      }),
    );
  });
  await flush();
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error(`Missing element in: ${document.body.textContent}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

const row = (name: string) =>
  [...document.querySelectorAll('[data-testid="computer-process-row"]')].find((el) => el.textContent?.includes(name));

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchComputerProcessLog.mockResolvedValue({ id: BUILD.id, text: 'step 1\n', truncated: false });
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('readableLog', () => {
  it('drops colour codes and keeps the last state of a redrawn line', () => {
    const esc = String.fromCharCode(27);
    expect(readableLog(`${esc}[32mok${esc}[0m done\n`)).toBe('ok done\n');
    expect(readableLog('Downloading 10%\rDownloading 55%\rDownloading 100%\nnext')).toBe('Downloading 100%\nnext');
    expect(readableLog('line\r\n')).toBe('line\n');
  });
});

describe('ComputerProcesses', () => {
  it('explains how long jobs get here when there are none', async () => {
    api.listComputerProcesses.mockResolvedValue([]);
    await renderProcesses();
    const text = document.body.textContent ?? '';
    expect(text).toContain('No background processes yet');
    expect(text).toContain('run_background');
    expect(text).toContain('gh-jobs start --name … -- <command>');
  });

  it('lists each job with its status, exit code and start', async () => {
    api.listComputerProcesses.mockResolvedValue([BUILD, FETCH, LINT, CRAWL]);
    await renderProcesses();
    expect(row('build')?.textContent).toContain('Running');
    expect(row('build')?.textContent).toContain('npm run build');
    expect(row('build')?.textContent).toContain('Started 5m ago');
    expect(row('fetch')?.textContent).toContain('Exit code 0');
    expect(row('lint')?.textContent).toContain('Exit code 2');
    expect(row('crawl')?.textContent).toContain('Interrupted');
    // Only a running job can be stopped.
    expect(row('build')?.querySelector('[data-testid="computer-process-stop"]')).not.toBeNull();
    expect(row('fetch')?.querySelector('[data-testid="computer-process-stop"]')).toBeNull();
  });

  it('shows a running job’s log and refreshes it every 3 seconds until the job ends', async () => {
    // Only the interval is faked: the refresh timer must be a fake one from the start.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    api.listComputerProcesses.mockResolvedValue([BUILD, FETCH]);
    await renderProcesses();
    await click(row('build')?.querySelector('button'));
    expect(api.fetchComputerProcessLog).toHaveBeenCalledWith(BUILD.id);
    expect(document.querySelector('[data-testid="computer-process-log-text"]')?.textContent).toBe('step 1\n');
    expect(document.body.textContent).toContain('Refreshing every 3 seconds');

    api.fetchComputerProcessLog.mockResolvedValue({ id: BUILD.id, text: 'step 1\nstep 2\n', truncated: false });
    await act(async () => {
      vi.advanceTimersByTime(PROCESS_REFRESH_MS);
    });
    await flush();
    expect(api.listComputerProcesses).toHaveBeenCalledTimes(2);
    expect(api.fetchComputerProcessLog).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="computer-process-log-text"]')?.textContent).toContain('step 2');

    // The job ends: the log is read once more, then the refreshing stops.
    api.listComputerProcesses.mockResolvedValue([
      { ...BUILD, status: 'exited', exit_code: 0, ended_at: new Date().toISOString() },
      FETCH,
    ]);
    api.fetchComputerProcessLog.mockResolvedValue({ id: BUILD.id, text: 'step 1\nstep 2\ndone\n', truncated: true });
    await act(async () => {
      vi.advanceTimersByTime(PROCESS_REFRESH_MS);
    });
    await flush();
    expect(api.fetchComputerProcessLog).toHaveBeenCalledTimes(4);
    expect(document.querySelector('[data-testid="computer-process-log-text"]')?.textContent).toContain('done');
    expect(document.body.textContent).toContain('Exit code 0');
    expect(document.body.textContent).toContain('Showing the end of the log.');
    expect(document.body.textContent).not.toContain('Refreshing every 3 seconds');

    await act(async () => {
      vi.advanceTimersByTime(PROCESS_REFRESH_MS * 3);
    });
    await flush();
    expect(api.listComputerProcesses).toHaveBeenCalledTimes(3);
    expect(api.fetchComputerProcessLog).toHaveBeenCalledTimes(4);
  });

  it('does not poll while another tab shows', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    api.listComputerProcesses.mockResolvedValue([BUILD]);
    await renderProcesses({ active: false });
    await act(async () => {
      vi.advanceTimersByTime(PROCESS_REFRESH_MS * 3);
    });
    expect(api.listComputerProcesses).not.toHaveBeenCalled();
  });

  it('stops a job only after confirmation', async () => {
    api.listComputerProcesses.mockResolvedValue([BUILD]);
    api.stopComputerProcess.mockResolvedValue({ id: BUILD.id, stopped: true });
    await renderProcesses();

    await click(row('build')?.querySelector('[data-testid="computer-process-stop"]'));
    expect(api.stopComputerProcess).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Stop “build”?');

    api.listComputerProcesses.mockResolvedValue([{ ...BUILD, status: 'exited', exit_code: 143 }]);
    await click(document.querySelector('[data-testid="confirm-dialog-confirm"]'));
    expect(api.stopComputerProcess).toHaveBeenCalledWith(BUILD.id);
    expect(document.body.textContent).toContain('Stopped build.');
    expect(row('build')?.textContent).toContain('Exit code 143');
  });

  it('stops from the log view, and says when the job had already finished', async () => {
    api.listComputerProcesses.mockResolvedValue([BUILD]);
    api.stopComputerProcess.mockResolvedValue({ id: BUILD.id, stopped: false });
    await renderProcesses();
    await click(row('build')?.querySelector('button'));

    await click(document.querySelector('[data-testid="computer-process-log"] [data-testid="computer-process-stop"]'));
    await click(document.querySelector('[data-testid="confirm-dialog-confirm"]'));
    expect(api.stopComputerProcess).toHaveBeenCalledWith(BUILD.id);
    expect(document.body.textContent).toContain('build had already finished.');
  });

  it('explains a failed stop and a list it could not load', async () => {
    api.listComputerProcesses.mockRejectedValueOnce(new BotsApiError('boom', 500));
    await renderProcesses();
    expect(document.body.textContent).toContain("Couldn't load the processes.");

    api.listComputerProcesses.mockResolvedValue([BUILD]);
    await click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Retry'));
    api.stopComputerProcess.mockRejectedValueOnce(new BotsApiError('boom', 500, 'something_new'));
    await click(row('build')?.querySelector('[data-testid="computer-process-stop"]'));
    await click(document.querySelector('[data-testid="confirm-dialog-confirm"]'));
    expect(document.body.textContent).toContain("Couldn't stop build.");
  });

  it('says a job’s log is gone when the server no longer knows the job', async () => {
    api.listComputerProcesses.mockResolvedValue([FETCH]);
    api.fetchComputerProcessLog.mockRejectedValue(new BotsApiError('No such job', 404, 'not_found'));
    await renderProcesses();
    await click(row('fetch')?.querySelector('button'));
    expect(document.querySelector('[data-testid="computer-process-log"]')?.textContent).toContain(
      'That file, folder or process no longer exists',
    );
  });

  it('goes back from a log to the list', async () => {
    api.listComputerProcesses.mockResolvedValue([BUILD, FETCH]);
    await renderProcesses();
    await click(row('fetch')?.querySelector('button'));
    expect(document.querySelector('[data-testid="computer-process-log"]')?.getAttribute('data-process-id')).toBe(
      FETCH.id,
    );
    await click(document.querySelector('button[aria-label="Back to processes"]'));
    expect(document.querySelector('[data-testid="computer-process-list"]')).not.toBeNull();
  });
});
