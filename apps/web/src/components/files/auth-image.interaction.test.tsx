/** @vitest-environment happy-dom */

/**
 * Chat-file images need the member's token: a Bot's browser screenshot (a
 * file artifact) and a Markdown image pointing at `/api/chat-files/:id/content`
 * are fetched with authFetch and shown through a blob: URL — never a bare
 * `<img src>` that would 401 — while every other image keeps its plain src.
 */

import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { Markdown } from '../markdown';
import { BodyArtifacts } from '../tool-call/body-artifacts';
import { resetAuthImageCacheForTest } from './auth-image';

const download = vi.hoisted(() => ({ fetchAuthenticatedBlob: vi.fn() }));
vi.mock('../../lib/file-download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/file-download')>()),
  fetchAuthenticatedBlob: download.fetchAuthenticatedBlob,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let urls = 0;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(element: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(I18nProvider, { initialLocale: 'en', children: element })));
  await flush();
}

beforeEach(() => {
  resetAuthImageCacheForTest();
  download.fetchAuthenticatedBlob.mockReset();
  urls = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${++urls}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('Markdown chat-file images', () => {
  it('loads /api/chat-files images with the token and leaves other images alone', async () => {
    download.fetchAuthenticatedBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    await mount(
      createElement(Markdown, {
        content: '![Screenshot](/api/chat-files/cf_1/content)\n\n![Chart](/api/upload/img_1)',
        compact: true,
      }),
    );

    expect(download.fetchAuthenticatedBlob).toHaveBeenCalledTimes(1);
    expect(download.fetchAuthenticatedBlob).toHaveBeenCalledWith('/api/chat-files/cf_1/content');
    const [shot, chart] = [...document.querySelectorAll('img')];
    expect(shot.getAttribute('data-auth-src')).toBe('/api/chat-files/cf_1/content');
    expect(shot.getAttribute('src')).toBe('blob:test-1');
    expect(chart.getAttribute('src')).toBe('/api/upload/img_1');
    expect(chart.hasAttribute('data-auth-src')).toBe(false);
  });

  it('never shows a chat file that is not a raster image', async () => {
    download.fetchAuthenticatedBlob.mockResolvedValue(new Blob(['<svg/>'], { type: 'image/svg+xml' }));
    await mount(createElement(Markdown, { content: '![x](/api/chat-files/cf_2/content)' }));
    const img = document.querySelector('img')!;
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.getAttribute('data-auth-failed')).toBe('true');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('does not put the token on a path that only looks like a chat file', async () => {
    await mount(createElement(Markdown, { content: '![x](/api/chat-files/../auth/me/content)' }));
    expect(download.fetchAuthenticatedBlob).not.toHaveBeenCalled();
    expect(document.querySelector('img[data-auth-src]')).toBeNull();
  });
});

describe('image file artifacts (a Bot’s browser screenshot)', () => {
  const screenshot = {
    name: 'browser',
    input: { action: 'screenshot' },
    output: {
      url: 'https://example.com/',
      title: 'Example',
      snapshot: '',
      type: 'file',
      file_id: 'cf_9',
      name: 'screenshot-20261005-061502.png',
      size: 2048,
      content_type: 'image/png',
      download_url: '/api/chat-files/cf_9/content',
    },
  };

  it('shows the picture (fetched with the token), not just a download link', async () => {
    download.fetchAuthenticatedBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    await mount(createElement(BodyArtifacts, { calls: [screenshot], ctx: {} }));

    expect(download.fetchAuthenticatedBlob).toHaveBeenCalledWith('/api/chat-files/cf_9/content');
    const img = document.querySelector<HTMLImageElement>('[data-testid="auth-image"]');
    expect(img?.getAttribute('src')).toBe('blob:test-1');
    expect(img?.getAttribute('alt')).toBe('screenshot-20261005-061502.png');
    // The file card (name, size, Download) stays under it.
    expect(document.body.textContent).toContain('Download');
  });

  it('keeps a spreadsheet a file card, with nothing fetched up front', async () => {
    const sheet = {
      ...screenshot,
      output: {
        ...screenshot.output,
        name: 'report.xlsx',
        content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    };
    await mount(createElement(BodyArtifacts, { calls: [sheet], ctx: {} }));
    expect(document.querySelector('[data-testid="file-artifact-image"]')).toBeNull();
    expect(download.fetchAuthenticatedBlob).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('report.xlsx');
  });

  it('shows a quiet placeholder when the picture cannot be loaded', async () => {
    download.fetchAuthenticatedBlob.mockRejectedValue(new Error('Download failed'));
    await mount(createElement(BodyArtifacts, { calls: [screenshot], ctx: {} }));
    expect(document.querySelector('[data-testid="auth-image"]')).toBeNull();
    expect(document.querySelector('[data-testid="auth-image-placeholder"]')?.getAttribute('data-failed')).toBe('true');
  });
});
