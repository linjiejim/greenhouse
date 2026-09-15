/**
 * The sidebar update prompt — the only place most people ever see an update.
 *
 * Two lines feed it (web bundle, shell) and one restart applies both, so the rule
 * under test is which prompt wins: showing them side by side would ask for two
 * restarts where one will do, and showing the web one while a downloaded shell
 * waits would quietly leave the shell uninstalled.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, type Locale } from '../../lib/i18n';
import type { WebReleaseNotes } from '../../lib/desktop/types';

const currentNotes: WebReleaseNotes = {
  schemaVersion: 1,
  appVersion: '0.44.0',
  webBundleVersion: '14',
  title: 'Current release',
  summary: 'Current summary',
  changes: ['Current change'],
  releasedAt: '2026-08-07T10:21:16.033Z',
};

const store = {
  pending: null as { version: string; releaseNotes: WebReleaseNotes | null } | null,
  currentReleaseNotes: null as WebReleaseNotes | null,
  releaseNotesHistory: [] as WebReleaseNotes[],
  requiredShellVersion: null as string | null,
  shellReadyVersion: null as string | null,
  shellInstalling: false,
  releaseNotesOpen: false,
  setReleaseNotesOpen: vi.fn(),
};

vi.mock('../../stores/desktop-update-store', () => ({
  useDesktopUpdateStore: (select: (state: typeof store) => unknown) => select(store),
}));
// The component refuses to render outside the shell, which is the whole point of
// the guard — so the test has to be inside one.
vi.mock('../../lib/desktop/bridge', () => ({ isDesktop: () => true }));
vi.mock('../../lib/desktop/updates', () => ({
  restartApp: vi.fn(),
  installShellUpdateAndRestart: vi.fn(),
}));

const { DesktopUpdateNotice } = await import('./desktop-update-notice');

beforeEach(() => {
  store.pending = null;
  store.requiredShellVersion = null;
  store.shellReadyVersion = null;
  store.shellInstalling = false;
  store.currentReleaseNotes = null;
  store.releaseNotesHistory = [];
  store.releaseNotesOpen = false;
});

function render(locale: Locale = 'en') {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <DesktopUpdateNotice />
    </I18nProvider>,
  );
}

describe('DesktopUpdateNotice', () => {
  it('says nothing when there is nothing to apply', () => {
    expect(render()).not.toContain('Restart');
  });

  it('offers a plain restart for a staged web bundle', () => {
    store.pending = { version: '12', releaseNotes: null };
    const html = render();

    expect(html).toContain('Restart now');
    expect(html).not.toContain('desktop app');
  });

  it('lets a downloaded shell supersede the web prompt — one restart does both', () => {
    store.pending = { version: '12', releaseNotes: null };
    store.shellReadyVersion = '0.41.0';
    const html = render();

    expect(html).toContain('Desktop app v0.41.0 is ready');
    // Not two cards, and not the web card's own button.
    expect(html).not.toContain('Restart now');
    expect(html).toContain('Restart to upgrade');
  });

  it('still asks for the download when the shell is required but not here yet', () => {
    store.requiredShellVersion = '0.7.0';
    const html = render();

    expect(html).toContain('requires desktop app v0.7.0 or later');
    expect(html).toContain('Update automatically and restart');
  });

  it('puts older/newer release controls beside the dialog title when history exists', () => {
    store.releaseNotesOpen = true;
    store.currentReleaseNotes = currentNotes;
    store.releaseNotesHistory = [
      currentNotes,
      { ...currentNotes, appVersion: '0.43.0', webBundleVersion: '13', title: 'Older release title' },
    ];
    const html = render();

    expect(html).toContain('aria-label="Older release"');
    expect(html).toContain('aria-label="Newer release"');
    expect(html).toContain('Current release');
    expect(html).not.toContain('Older release title');
  });

  it('keeps release history navigation in a stable, scrollable workspace', () => {
    store.releaseNotesOpen = true;
    store.currentReleaseNotes = currentNotes;

    const html = render();

    expect(html).toContain('sm:w-[80vw]');
    expect(html).toContain('h-[min(42rem,calc(100dvh-10rem))]');
    expect(html).toContain('overflow-y-auto');
    expect(html).toContain('[scrollbar-gutter:stable]');
  });
});
