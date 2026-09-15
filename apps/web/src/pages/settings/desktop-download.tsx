/**
 * Settings → Desktop, as seen from a browser: download the desktop app.
 *
 * The desktop-only controls (shortcuts, permissions, updates) live in
 * `desktop.tsx`; this panel is what the same nav entry renders when the page is
 * NOT running inside the shell. It reads the published release index and offers
 * the installer — or says plainly that none has been published yet.
 */

import { useEffect, useState } from 'react';
import { Card, Spinner } from '../../components/ui';
import { Download, Monitor } from '../../lib/icons';
import { fetchAppDownloads, type AppDownloads } from '../../lib/desktop/app-release';
import { useT } from '../../lib/i18n';
import { formatDay } from '../../lib/utils';

export function DesktopDownloadPanel() {
  const t = useT();
  const [downloads, setDownloads] = useState<AppDownloads | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void fetchAppDownloads().then((result) => {
      if (cancelled) return;
      setDownloads(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Only used to order the list and pick which install steps to show — every
  // published platform stays visible (people download for their other machine).
  const ua = navigator.platform || navigator.userAgent;
  const visitorOs: 'mac' | 'windows' | 'other' = /Mac/i.test(ua) ? 'mac' : /Win/i.test(ua) ? 'windows' : 'other';
  const matchesVisitor = (key: string) =>
    (visitorOs === 'mac' && key.startsWith('darwin-')) || (visitorOs === 'windows' && key.startsWith('windows-'));
  const entries = downloads
    ? Object.entries(downloads.platforms).sort(([a], [b]) => Number(matchesVisitor(b)) - Number(matchesVisitor(a)))
    : [];
  const visitorHasInstaller = visitorOs === 'other' || entries.some(([key]) => matchesVisitor(key));

  return (
    <div className="space-y-4">
      <section>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <Monitor size={16} className="text-fg-muted" />
          {t('desktop.desktopApp')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-fg-muted">{t('desktop.desktopAppDesc')}</p>
      </section>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-fg-faint">
          <Spinner />
          {t('desktop.loadingRelease')}
        </div>
      ) : downloads ? (
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-fg">Greenhouse v{downloads.version}</div>
              <div className="mt-0.5 text-xs text-fg-faint">
                {t('desktop.releasedOn', { date: formatDay(downloads.releasedAt) })}
              </div>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {entries.map(([key, platform]) => (
              <div key={key} className="rounded-lg border border-edge px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-fg">{platform.label}</div>
                    <div className="text-xs text-fg-faint">
                      {(platform.sizeBytes / 1_048_576).toFixed(1)} MB · .{platform.url.split('?')[0].split('.').pop()}
                    </div>
                  </div>
                  <a
                    href={platform.url}
                    className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-700"
                  >
                    <Download size={14} />
                    {t('desktop.download')}
                  </a>
                </div>
                {key.startsWith('windows-') && (
                  <p className="mt-1.5 text-xs leading-5 text-fg-faint">{t('desktop.windowsUnsigned')}</p>
                )}
              </div>
            ))}
          </div>
          {!visitorHasInstaller && <p className="mt-3 text-xs text-fg-faint">{t('desktop.platformUnavailable')}</p>}
        </Card>
      ) : (
        <Card className="p-4">
          <div className="text-sm text-fg-muted">{t('desktop.noInstaller')}</div>
          <p className="mt-1 text-xs leading-5 text-fg-faint">{t('desktop.noInstallerHint')}</p>
        </Card>
      )}

      <section>
        <h4 className="text-xs font-semibold text-fg-secondary">{t('desktop.firstInstall')}</h4>
        {visitorOs !== 'windows' && (
          <>
            {visitorOs === 'other' && <div className="mt-2 text-xs font-medium text-fg-secondary">macOS</div>}
            <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs leading-5 text-fg-muted">
              <li>{t('desktop.installStep1')}</li>
              <li>{t('desktop.installStep2')}</li>
            </ol>
          </>
        )}
        {visitorOs !== 'mac' && (
          <>
            {visitorOs === 'other' && <div className="mt-2 text-xs font-medium text-fg-secondary">Windows</div>}
            <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs leading-5 text-fg-muted">
              <li>{t('desktop.winInstallStep1')}</li>
              <li>{t('desktop.winInstallStep2')}</li>
            </ol>
          </>
        )}
        <p className="mt-2 text-xs leading-5 text-fg-faint">{t('desktop.installStep3')}</p>
      </section>
    </div>
  );
}
