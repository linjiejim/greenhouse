/**
 * Settings → Desktop → App & updates: the published-shell-update section.
 *
 * This is the only place inside the app that hands out the installer, so a
 * regression here (a dropped button, copy that stops explaining the overwrite)
 * leaves someone whose in-app update failed with nothing to click — which is
 * exactly the dead end this section was added to remove.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, type Locale } from '../../lib/i18n';

// Only two flags are read from the store here; mocking them keeps this a pure
// render test rather than a zustand-under-SSR test.
const store = { shellInstalling: false, shellReadyVersion: null as string | null };
vi.mock('../../stores/desktop-update-store', () => ({
  useDesktopUpdateStore: (select: (state: typeof store) => unknown) => select(store),
}));

const { ShellUpdateSection } = await import('./desktop');

beforeEach(() => {
  store.shellInstalling = false;
  store.shellReadyVersion = null;
});

const release = {
  version: '0.41.0',
  nativeApiVersion: '0.7.0',
  releasedAt: '2026-08-06T02:00:00.000Z',
  platforms: {},
};
const installer = {
  label: 'macOS (Apple Silicon)',
  url: 'https://greenhouse.example.com/updates/desktop/stable/app/Greenhouse-0.41.0-aarch64.dmg',
  sizeBytes: 7_660_350,
};

function render(locale: Locale, requiredShellVersion: string | null = null) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ShellUpdateSection release={release} installer={installer} requiredShellVersion={requiredShellVersion} />
    </I18nProvider>,
  );
}

describe('ShellUpdateSection', () => {
  it('offers both ways to take the update, with the automatic one first', () => {
    const html = render('en');

    expect(html).toContain('Update automatically and restart');
    expect(html).toContain('Download installer');
    expect(html.indexOf('Update automatically and restart')).toBeLessThan(html.indexOf('Download installer'));
  });

  it('says what will be downloaded and what to do with it', () => {
    const html = render('en');

    expect(html).toContain('v0.41.0');
    expect(html).toContain('macOS (Apple Silicon)');
    expect(html).toContain('7.3 MB');
    // Downloading is only half the job — the overwrite is the part people get wrong.
    expect(html).toContain('drag the app into Applications');
  });

  it('explains a blocked hot update when that is why the shell must move', () => {
    // Same section, two reasons to be there: a newer app exists, or the interface
    // already waiting to install needs it.
    expect(render('en')).toContain('Update in place and restart');
    expect(render('en', '0.7.0')).toContain('requires desktop app v0.7.0 or later');
  });

  it('drops the wait once the background pass has the bytes', () => {
    store.shellReadyVersion = '0.41.0';
    const html = render('en');

    // Promising an "automatic update" here would imply a download that already
    // happened; all that is left is the restart.
    expect(html).toContain('Restart to upgrade');
    expect(html).not.toContain('Update automatically and restart');
    expect(html).toContain('Already downloaded in the background');
    // The manual route stays available — it is the fallback for a failing install.
    expect(html).toContain('Download installer');
  });

  it('keeps offering the download while a different version is the one waiting', () => {
    store.shellReadyVersion = '0.40.0';
    const html = render('en');

    expect(html).toContain('Update automatically and restart');
    expect(html).not.toContain('Already downloaded in the background');
  });

  it('renders in Chinese too', () => {
    const html = render('zh');

    expect(html).toContain('有新版桌面应用');
    expect(html).toContain('下载安装包');
    expect(html).toContain('覆盖同名旧版本');
  });

  it('explains the overwrite in Windows terms when the installer is a setup.exe', () => {
    const winInstaller = {
      label: 'Windows (x64)',
      url: 'https://greenhouse.example.com/updates/desktop/stable/app/Greenhouse-0.41.0-x86_64-setup.exe',
      sizeBytes: 5_242_880,
    };
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <ShellUpdateSection release={release} installer={winInstaller} requiredShellVersion={null} />
      </I18nProvider>,
    );

    expect(html).toContain('run the setup.exe');
    expect(html).not.toContain('drag the app into Applications');
  });
});
