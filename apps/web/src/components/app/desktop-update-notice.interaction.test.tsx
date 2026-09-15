/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebReleaseNotes } from '../../lib/desktop/types';
import { I18nProvider } from '../../lib/i18n';
import { ReleaseNotesDialog } from './desktop-update-notice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mountedRoot: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (mountedRoot) await act(async () => mountedRoot?.unmount());
  container?.remove();
  mountedRoot = null;
  container = null;
});

const current: WebReleaseNotes = {
  schemaVersion: 1,
  appVersion: '0.44.0',
  webBundleVersion: '14',
  title: 'Current release',
  summary: 'Current summary',
  changes: ['Current change'],
  releasedAt: '2026-08-07T10:21:16.033Z',
};
const older: WebReleaseNotes = {
  ...current,
  appVersion: '0.43.0',
  webBundleVersion: '13',
  title: 'Older release title',
  summary: 'Older summary',
};

describe('ReleaseNotesDialog history navigation', () => {
  it('moves to an older release and back with the title-bar arrow buttons', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    mountedRoot = createRoot(container);

    await act(async () => {
      mountedRoot?.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(ReleaseNotesDialog, {
            notes: [current, older],
            pendingVersion: null,
            restartPending: false,
            open: true,
            onClose: () => undefined,
          }),
        }),
      );
    });

    const olderButton = document.querySelector<HTMLButtonElement>('button[aria-label="Older release"]');
    const newerButton = document.querySelector<HTMLButtonElement>('button[aria-label="Newer release"]');
    expect(document.body.textContent).toContain('Current release');
    expect(olderButton?.disabled).toBe(false);
    expect(newerButton?.disabled).toBe(true);

    await act(async () => olderButton?.click());
    expect(document.body.textContent).toContain('Older release title');
    expect(document.body.textContent).not.toContain('Current summary');
    expect(newerButton?.disabled).toBe(false);

    await act(async () => newerButton?.click());
    expect(document.body.textContent).toContain('Current summary');
  });
});
