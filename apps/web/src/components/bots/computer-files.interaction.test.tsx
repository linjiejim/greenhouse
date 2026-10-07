/** @vitest-environment happy-dom */

/**
 * The computer's Files tab with a mocked API: browsing (rows, breadcrumb,
 * shortcuts), downloads, uploads from the button and by drag-and-drop (with
 * progress, one at a time, nothing over 100 MB), and failures that say why.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputerFileList } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { BotsApiError } from '../../lib/api/bots';
import { ToastContainer } from '../ui';
import { ComputerFiles, displayPath, homeSegments } from './computer-files';

const api = vi.hoisted(() => ({
  listComputerFiles: vi.fn(),
  downloadComputerFile: vi.fn(),
  uploadComputerFile: vi.fn(),
}));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORK: ComputerFileList = {
  path: '/home/agent/work',
  entries: [
    { name: 'data', type: 'dir', size: 0, mtime: '2026-10-07T08:00:00.000Z' },
    { name: 'latest', type: 'link', size: 0, mtime: '2026-10-07T08:00:00.000Z' },
    { name: 'report.pdf', type: 'file', size: 2048, mtime: '2026-10-07T09:30:00.000Z' },
    { name: 'socket', type: 'other', size: 0, mtime: '2026-10-07T09:30:00.000Z' },
  ],
  truncated: false,
};

function folder(path: string, entries: ComputerFileList['entries'] = [], truncated = false): ComputerFileList {
  return { path, entries, truncated };
}

let root: ReturnType<typeof createRoot> | null = null;

async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderFiles(props: { active?: boolean; onStale?: () => void } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: [
          createElement(ComputerFiles, { key: 'files', active: props.active ?? true, onStale: props.onStale }),
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

const rows = () => [...document.querySelectorAll('[data-testid="computer-file-row"]')];
const row = (name: string) => rows().find((el) => el.textContent?.includes(name));
const breadcrumb = () => document.querySelector('[data-testid="computer-files-breadcrumb"]');

function file(name: string, size: number): File {
  const created = new File(['x'], name, { type: 'application/octet-stream' });
  Object.defineProperty(created, 'size', { value: size });
  return created;
}

/** Pick files with the hidden input, as the Upload button's dialog does. */
async function pick(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('[data-testid="computer-files-input"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

function dragEvent(type: string, files: File[] = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: 'none' } });
  return event;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listComputerFiles.mockImplementation(async (path?: string) =>
    path === '~/work' || path === '/home/agent/work' ? WORK : folder(path?.replace(/^~/, '/home/agent') ?? ''),
  );
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('home paths', () => {
  it('reads the folders below the home folder', () => {
    expect(homeSegments('/home/agent')).toEqual([]);
    expect(homeSegments('/home/agent/work/a/')).toEqual(['work', 'a']);
    expect(homeSegments('~/Downloads')).toEqual(['Downloads']);
    expect(displayPath('/home/agent/work/a')).toBe('~/work/a');
    expect(displayPath('/home/agent')).toBe('~');
  });
});

describe('ComputerFiles browsing', () => {
  it('opens in ~/work and lists folders, links and files with size and date', async () => {
    await renderFiles();
    expect(api.listComputerFiles).toHaveBeenCalledWith('~/work');
    expect(rows().map((el) => el.getAttribute('data-type'))).toEqual(['dir', 'link', 'file', 'other']);
    expect(row('report.pdf')?.textContent).toContain('2 KB');
    expect(breadcrumb()?.textContent).toContain('work');
    // A file and a link can be downloaded; a folder and a socket cannot.
    expect(row('report.pdf')?.querySelector('[data-testid="computer-file-download"]')).not.toBeNull();
    expect(row('latest')?.querySelector('[data-testid="computer-file-download"]')).not.toBeNull();
    expect(row('data')?.querySelector('[data-testid="computer-file-download"]')).toBeNull();
    expect(row('socket')?.querySelector('button')).toBeNull();
  });

  it('walks into a folder and back up through the breadcrumb', async () => {
    api.listComputerFiles.mockImplementation(async (path?: string) => {
      if (path === '/home/agent/work/data') {
        return folder('/home/agent/work/data', [
          { name: 'raw.csv', type: 'file', size: 10, mtime: '2026-10-07T08:00:00.000Z' },
        ]);
      }
      return WORK;
    });
    await renderFiles();

    await click(row('data')?.querySelector('button'));
    expect(api.listComputerFiles).toHaveBeenLastCalledWith('/home/agent/work/data');
    expect(breadcrumb()?.textContent).toContain('work');
    expect(breadcrumb()?.textContent).toContain('data');
    expect(row('raw.csv')).toBeDefined();

    const up = [...(breadcrumb()?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'work');
    await click(up);
    expect(api.listComputerFiles).toHaveBeenLastCalledWith('/home/agent/work');
  });

  it('jumps to ~/Downloads and ~ with the shortcuts', async () => {
    await renderFiles();
    await click(document.querySelector('[data-testid="computer-files-shortcut-downloads"]'));
    expect(api.listComputerFiles).toHaveBeenLastCalledWith('~/Downloads');
    expect(document.body.textContent).toContain('This folder is empty');

    await click(document.querySelector('[data-testid="computer-files-shortcut-home"]'));
    expect(api.listComputerFiles).toHaveBeenLastCalledWith('~');
  });

  it('says when a folder has more entries than shown', async () => {
    api.listComputerFiles.mockResolvedValue(folder('/home/agent/work', WORK.entries, true));
    await renderFiles();
    expect(document.body.textContent).toContain('Showing the first 4 items.');
  });

  it('explains a folder it cannot open and retries', async () => {
    api.listComputerFiles.mockRejectedValueOnce(new BotsApiError('boom', 500));
    await renderFiles();
    expect(document.body.textContent).toContain("Couldn't open this folder.");

    await click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Retry'));
    expect(rows()).toHaveLength(4);
  });

  it('says a folder is gone when the server says not_found', async () => {
    api.listComputerFiles.mockRejectedValueOnce(new BotsApiError('No such folder', 404, 'not_found'));
    await renderFiles();
    expect(document.body.textContent).toContain(
      'That file, folder or process no longer exists — it may have been deleted.',
    );
  });

  it('asks the pane to re-read the computer when it has stopped', async () => {
    const onStale = vi.fn();
    api.listComputerFiles.mockRejectedValueOnce(new BotsApiError('stopped', 409, 'stopped'));
    await renderFiles({ onStale });
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("The computer isn't running.");
  });

  it('reads nothing while hidden, and re-reads the folder each time the tab is shown', async () => {
    await renderFiles({ active: false });
    expect(api.listComputerFiles).not.toHaveBeenCalled();

    const show = async (active: boolean) => {
      await act(async () => {
        root?.render(
          createElement(I18nProvider, {
            initialLocale: 'en',
            children: [
              createElement(ComputerFiles, { key: 'files', active }),
              createElement(ToastContainer, { key: 'toasts' }),
            ],
          }),
        );
      });
      await flush();
    };
    await show(true);
    expect(api.listComputerFiles).toHaveBeenCalledTimes(1);
    await show(false);
    await show(true);
    // The Bots may have written files meanwhile.
    expect(api.listComputerFiles).toHaveBeenCalledTimes(2);
  });
});

describe('ComputerFiles transfers', () => {
  it('downloads a file by its full path', async () => {
    api.downloadComputerFile.mockResolvedValue(undefined);
    await renderFiles();
    await click(row('report.pdf')?.querySelector('[data-testid="computer-file-download"]'));
    expect(api.downloadComputerFile).toHaveBeenCalledWith('/home/agent/work/report.pdf', 'report.pdf');
  });

  it('names the file a download failed for', async () => {
    api.downloadComputerFile.mockRejectedValue(new BotsApiError('boom', 500));
    await renderFiles();
    await click(row('report.pdf')?.querySelector('[data-testid="computer-file-download"]'));
    expect(document.body.textContent).toContain("Couldn't download report.pdf.");
  });

  it('says why a download was refused: too large, or gone', async () => {
    api.downloadComputerFile.mockRejectedValueOnce(new BotsApiError('Over 1 GiB', 413, 'too_large'));
    await renderFiles();
    await click(row('report.pdf')?.querySelector('[data-testid="computer-file-download"]'));
    expect(document.body.textContent).toContain('uploads are limited to 100 MB, downloads to 1 GB');

    api.downloadComputerFile.mockRejectedValueOnce(new BotsApiError('No such file', 404, 'not_found'));
    await click(row('report.pdf')?.querySelector('[data-testid="computer-file-download"]'));
    expect(document.body.textContent).toContain('That file, folder or process no longer exists');
  });

  it('uploads picked files into the folder one at a time, with progress, then re-reads it', async () => {
    const first = deferred<void>();
    let progress: ((loaded: number, total: number) => void) | undefined;
    api.uploadComputerFile.mockImplementation(
      async (_dir: string, picked: File, options: { onProgress?: (loaded: number, total: number) => void }) => {
        if (picked.name === 'a.csv') {
          progress = options.onProgress;
          await first.promise;
        }
        return { entry: { name: picked.name, type: 'file', size: picked.size, mtime: '' }, path: '' };
      },
    );
    await renderFiles();
    api.listComputerFiles.mockClear();

    await pick([file('a.csv', 1000), file('b.csv', 10)]);
    expect(api.uploadComputerFile).toHaveBeenCalledTimes(1);
    expect(api.uploadComputerFile).toHaveBeenCalledWith(
      '/home/agent/work',
      expect.objectContaining({ name: 'a.csv' }),
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );

    await act(async () => progress?.(500, 1000));
    const uploading = document.querySelector('[data-testid="computer-upload"][data-state="uploading"]');
    expect(uploading?.textContent).toContain('50%');
    expect(uploading?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');

    await act(async () => first.resolve());
    await flush();
    expect(api.uploadComputerFile).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('Uploaded 2 file(s) to ~/work');
    expect(document.querySelector('[data-testid="computer-uploads"]')).toBeNull();
    expect(api.listComputerFiles).toHaveBeenCalledWith('/home/agent/work');
  });

  it('takes files dropped onto the tab', async () => {
    api.uploadComputerFile.mockResolvedValue({
      entry: { name: 'notes.txt', type: 'file', size: 3, mtime: '' },
      path: '/home/agent/work/notes.txt',
    });
    await renderFiles();
    const zone = document.querySelector('[data-testid="computer-files"]')!;

    await act(async () => {
      zone.dispatchEvent(dragEvent('dragenter'));
    });
    expect(document.querySelector('[data-testid="computer-files-drop"]')?.textContent).toContain(
      'Drop to upload to ~/work',
    );

    const drop = dragEvent('drop', [file('notes.txt', 3)]);
    await act(async () => {
      zone.dispatchEvent(drop);
    });
    await flush();
    expect(drop.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-testid="computer-files-drop"]')).toBeNull();
    expect(api.uploadComputerFile).toHaveBeenCalledWith(
      '/home/agent/work',
      expect.objectContaining({ name: 'notes.txt' }),
      expect.anything(),
    );
  });

  it('refuses a file over 100 MB without sending it, and keeps the others going', async () => {
    api.uploadComputerFile.mockResolvedValue({ entry: { name: 'ok.txt', type: 'file', size: 1, mtime: '' }, path: '' });
    await renderFiles();
    await pick([file('movie.mkv', 101 * 1024 * 1024), file('ok.txt', 1)]);

    expect(api.uploadComputerFile).toHaveBeenCalledTimes(1);
    expect(api.uploadComputerFile.mock.calls[0][1].name).toBe('ok.txt');
    const failed = document.querySelector('[data-testid="computer-upload"][data-state="failed"]');
    expect(failed?.textContent).toContain('movie.mkv is larger than 100 MB.');

    await click(failed?.querySelector('button[aria-label="Dismiss"]'));
    expect(document.querySelector('[data-testid="computer-uploads"]')).toBeNull();
  });

  it('says why an upload failed', async () => {
    api.uploadComputerFile.mockRejectedValue(new BotsApiError('Disk full', 409, 'over_quota'));
    await renderFiles();
    await pick([file('big.zip', 10)]);
    expect(document.querySelector('[data-testid="computer-upload"][data-state="failed"]')?.textContent).toContain(
      "The computer's disk is full.",
    );
  });

  it('reads the server refusing an upload as too large — with its code, or a bare 413 from a proxy', async () => {
    api.uploadComputerFile
      .mockRejectedValueOnce(new BotsApiError('Files up to 100 MiB can be uploaded', 413, 'too_large'))
      .mockRejectedValueOnce(new BotsApiError('Request Entity Too Large', 413));
    await renderFiles();
    await pick([file('a.bin', 10), file('b.bin', 10)]);
    const failed = [...document.querySelectorAll('[data-testid="computer-upload"][data-state="failed"]')];
    expect(failed).toHaveLength(2);
    for (const row of failed) expect(row.textContent).toContain('uploads are limited to 100 MB');
  });
});
