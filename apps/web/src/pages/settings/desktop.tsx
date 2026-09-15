/**
 * Settings → Desktop. Inside the shell this page manages native capabilities;
 * in a browser it renders the installer download instead (desktop-download.tsx),
 * because every other control here drives a native command.
 *
 * This page is where the native capabilities become *usable*: without it the shell
 * can capture screens and watch selections, but nobody can grant the permissions
 * those need or turn the watcher on.
 *
 * Flat sub-panel style per the settings convention — no card-on-card.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Input, Select, Spinner, StatusDot, Tabs, toast } from '../../components/ui';
import { Check, Download, MonitorDown, RefreshCw, ScrollText, Server, ShieldCheck } from '../../lib/icons';
import { invokeDesktop, isDesktop } from '../../lib/desktop/bridge';
import { getCapabilities, requestPermission } from '../../lib/desktop/capabilities';
import {
  fetchAppDownloads,
  installerFor,
  isNewerRelease,
  type AppDownloadPlatform,
  type AppDownloads,
} from '../../lib/desktop/app-release';
import {
  checkForWebUpdateManually,
  downloadShellInstaller,
  installShellUpdateAndRestart,
  restartApp,
} from '../../lib/desktop/updates';
import type { DesktopCapabilities, DesktopInfo, DesktopSettings, Permission } from '../../lib/desktop/types';
import { useDesktopUpdateStore } from '../../stores/desktop-update-store';
import {
  DesktopSelectionWatcherSection,
  DesktopShortcutsSection,
  DesktopSurfaceProfilesSection,
} from '../desktop/preferences';
import { DesktopDownloadPanel } from './desktop-download';
import { useT, type TranslationKey } from '../../lib/i18n';
import { formatDay } from '../../lib/utils';
import { ModulePage } from '../../components/app/module-page';

export function DesktopPanel() {
  // Same nav entry, two worlds: in a browser this page cannot drive any native
  // command, so it offers the installer instead.
  if (!isDesktop()) {
    return (
      <ModulePage moduleId="settings.desktop" layout="form">
        <DesktopDownloadPanel />
      </ModulePage>
    );
  }
  return <DesktopNativePanel />;
}

function DesktopNativePanel() {
  const t = useT();
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [caps, setCaps] = useState<DesktopCapabilities | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('capabilities');
  const [release, setRelease] = useState<AppDownloads | null>(null);
  const setReleaseNotesOpen = useDesktopUpdateStore((state) => state.setReleaseNotesOpen);
  const requiredShellVersion = useDesktopUpdateStore((state) => state.requiredShellVersion);

  const reload = useCallback(async () => {
    const [nextInfo, nextSettings, nextCaps, nextRelease] = await Promise.all([
      invokeDesktop('desktop_info'),
      invokeDesktop('desktop_get_settings'),
      getCapabilities({ refresh: true }),
      // Never throws: the index legitimately does not exist against a dev API, and
      // a missing one only means this page cannot offer a shell update.
      fetchAppDownloads(),
    ]);
    setInfo(nextInfo);
    setSettings(nextSettings);
    setCaps(nextCaps);
    setRelease(nextRelease);
  }, []);

  useEffect(() => {
    const refresh = () => void reload().catch((err) => toast(String(err), 'error'));
    refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [reload]);

  if (!info || !settings || !caps) {
    return (
      <ModulePage moduleId="settings.desktop" layout="form">
        <div className="flex items-center gap-2 text-sm text-fg-faint">
          <Spinner />
          {t('desktop.loadingInfo')}
        </div>
      </ModulePage>
    );
  }

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
      await reload().catch(() => {});
    }
  };

  const grant = (permission: Permission) =>
    run(`perm:${permission}`, async () => {
      await requestPermission(permission);
      toast(t('desktop.permissionSettingsOpened'), 'info');
    });

  // Only offer a shell update we could actually deliver on this machine: a newer
  // published release *and* an installer built for this platform.
  const installer = release && isNewerRelease(release.version, info.shellVersion) ? installerFor(release, info) : null;

  return (
    <ModulePage
      moduleId="settings.desktop"
      layout="form"
      tabs={
        <Tabs
          tabs={[
            { key: 'capabilities', label: t('desktop.tabCapabilities') },
            { key: 'launchers', label: t('desktop.tabLaunchers') },
            { key: 'shortcuts', label: t('desktop.globalShortcuts') },
            { key: 'app', label: t('desktop.tabAppAndUpdates') },
          ]}
          active={activeTab}
          onChange={setActiveTab}
        />
      }
    >
      <div className="space-y-4">
        {activeTab === 'capabilities' && (
          <div className="space-y-8">
            {caps.permissions.applicable && (
              <section>
                <SectionHeader icon={<ShieldCheck size={16} />} title={t('desktop.systemPermissions')}>
                  {t('desktop.systemPermissionsHint')}
                </SectionHeader>
                <Card className="divide-y divide-edge p-0">
                  <PermissionRow
                    granted={caps.permissions.accessibility}
                    title={t('desktop.accessibility')}
                    detail={t('desktop.accessibilityHint')}
                    busy={busy === 'perm:accessibility'}
                    t={t}
                    onGrant={() => void grant('accessibility')}
                  />
                  <PermissionRow
                    granted={caps.permissions.screenRecording}
                    title={t('desktop.screenRecording')}
                    detail={t('desktop.screenRecordingHint')}
                    busy={busy === 'perm:screen_recording'}
                    t={t}
                    onGrant={() => void grant('screen_recording')}
                  />
                </Card>
              </section>
            )}
            <DesktopSelectionWatcherSection />
          </div>
        )}

        {activeTab === 'launchers' && <DesktopSurfaceProfilesSection />}
        {activeTab === 'shortcuts' && <DesktopShortcutsSection />}

        {activeTab === 'app' && (
          <div className="space-y-8">
            {release && installer && (
              <ShellUpdateSection release={release} installer={installer} requiredShellVersion={requiredShellVersion} />
            )}

            {/* The shell reports `apiBaseLocked` only when a server was baked in at
                build time. A packaged build without one keeps the server as a
                setting, so this keys off the flag, never off "is this a dev build". */}
            <section>
              <SectionHeader icon={<Server size={16} />} title={t('desktop.server')}>
                {settings.apiBaseLocked ? t('desktop.serverLockedHint') : t('desktop.serverEditableHint')}
              </SectionHeader>
              {settings.apiBaseLocked ? (
                <Card className="flex items-center gap-2 p-4 text-sm">
                  <StatusDot color="success" />
                  <code className="text-fg-secondary">{settings.apiBaseUrl}</code>
                </Card>
              ) : (
                <ServerPicker
                  current={settings.apiBaseUrl}
                  busy={busy === 'server'}
                  t={t}
                  onSelect={(url) =>
                    run('server', async () => {
                      await invokeDesktop('desktop_set_api_base', { url });
                    })
                  }
                />
              )}
            </section>

            <section>
              <SectionHeader icon={<RefreshCw size={16} />} title={t('desktop.versionsAndUpdates')}>
                {t('desktop.versionsAndUpdatesHint')}
              </SectionHeader>
              <Card className="space-y-2 p-4 text-sm">
                <Row label={t('desktop.interfaceVersionLabel')}>
                  v{info.webBundleVersion}
                  <span className="ml-2 text-xs text-fg-faint">{describeBundle(info, t)}</span>
                </Row>
                <Row label={t('desktop.shellVersionLabel')}>
                  v{info.shellVersion}
                  <span className="ml-2 text-xs text-fg-faint">
                    {info.platform} / {info.arch}
                  </span>
                </Row>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === 'update'}
                    onClick={() =>
                      run('update', async () => {
                        await checkForWebUpdateManually();
                      })
                    }
                  >
                    {busy === 'update' ? <Spinner /> : <RefreshCw size={14} />}
                    <span className="ml-1.5">{t('desktop.checkUpdates')}</span>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void restartApp()}>
                    {t('desktop.restartApp')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setReleaseNotesOpen(true)}>
                    <ScrollText size={14} />
                    <span className="ml-1.5">{t('desktop.releaseNotes')}</span>
                  </Button>
                </div>
              </Card>
            </section>
          </div>
        )}
      </div>
    </ModulePage>
  );
}

// ─── Pieces ──────────────────────────────────────────────

/**
 * A published shell update, with both ways of taking it.
 *
 * "Update automatically" is the smooth path and stays first. "Download installer"
 * exists because that path is a single point of failure: it can fail on a machine
 * (permissions, a half-replaced .app), and until it did there was nowhere in the
 * app to get the package — the only advice was to open a browser.
 *
 * Exported for `desktop-shell-update.render.test.tsx`; nothing else renders it.
 */
export function ShellUpdateSection({
  release,
  installer,
  requiredShellVersion,
}: {
  release: AppDownloads;
  installer: AppDownloadPlatform;
  requiredShellVersion: string | null;
}) {
  const t = useT();
  const shellInstalling = useDesktopUpdateStore((state) => state.shellInstalling);
  const shellReadyVersion = useDesktopUpdateStore((state) => state.shellReadyVersion);
  // null = not downloading; 0…1 = how far along. The download takes minutes on the
  // real update source, so the button reports rather than just spins.
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const downloading = progress !== null;
  const busy = shellInstalling || downloading;
  // Already downloaded in the background: the button is a restart, not a download,
  // and saying "update automatically" would imply a wait that no longer exists.
  const ready = shellReadyVersion === release.version;

  const update = async () => {
    setError(null);
    try {
      const outcome = await installShellUpdateAndRestart();
      if (outcome === 'not_ready') toast(t('desktop.shellNotReady'), 'info');
    } catch (err) {
      setError(t('desktop.autoUpdateFailed', { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const download = async () => {
    setError(null);
    setProgress(0);
    try {
      const saved = await downloadShellInstaller(setProgress);
      toast(t('desktop.installerDownloaded', { path: saved.path }), 'success');
    } catch (err) {
      setError(t('desktop.downloadFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setProgress(null);
    }
  };

  return (
    <section>
      <SectionHeader icon={<MonitorDown size={16} />} title={t('desktop.appUpdateAvailable')}>
        {ready
          ? t('desktop.appUpdateReadyHint')
          : requiredShellVersion
            ? t('desktop.shellVersionRequired', { version: requiredShellVersion })
            : t('desktop.appUpdateHint')}
      </SectionHeader>
      <Card className="space-y-3 p-4 text-sm">
        <Row label={t('desktop.newVersionLabel')}>
          v{release.version}
          <span className="ml-2 text-xs text-fg-faint">
            {installer.label} · {(installer.sizeBytes / 1_048_576).toFixed(1)} MB ·{' '}
            {t('desktop.releasedOn', { date: formatDay(release.releasedAt) })}
          </span>
        </Row>
        {error && <div className="text-xs leading-5 text-danger">{error}</div>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void update()}>
            {shellInstalling ? <Spinner /> : ready ? <RefreshCw size={14} /> : <MonitorDown size={14} />}
            <span className="ml-1.5">
              {shellInstalling
                ? t('desktop.installing')
                : ready
                  ? t('desktop.restartUpgrade')
                  : t('desktop.autoUpdateRestart')}
            </span>
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void download()}>
            {downloading ? <Spinner /> : <Download size={14} />}
            <span className="ml-1.5">
              {downloading
                ? t('desktop.downloadingInstaller', { percent: Math.round((progress ?? 0) * 100) })
                : t('desktop.downloadInstaller')}
            </span>
          </Button>
        </div>
        <p className="text-xs leading-5 text-fg-faint">
          {t(
            installer.url.endsWith('.exe') ? 'desktop.installerOverwriteHintWindows' : 'desktop.installerOverwriteHint',
          )}
        </p>
      </Card>
    </section>
  );
}

function SectionHeader({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-fg">
        <span className="text-fg-muted">{icon}</span>
        {title}
      </div>
      {children && <p className="mt-1 text-xs text-fg-faint">{children}</p>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-24 shrink-0 text-xs text-fg-faint">{label}</span>
      <span className="text-fg-secondary">{children}</span>
    </div>
  );
}

function PermissionRow({
  granted,
  title,
  detail,
  busy,
  t,
  onGrant,
}: {
  granted: boolean;
  title: string;
  detail: string;
  busy: boolean;
  t: ReturnType<typeof useT>;
  onGrant: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="flex items-center gap-2">
        <StatusDot color={granted ? 'success' : 'warning'} />
        <div>
          <div className="text-sm text-fg">{title}</div>
          <div className="text-xs text-fg-faint">{detail}</div>
        </div>
      </div>
      {granted ? (
        <span className="flex items-center gap-1 text-xs text-fg-faint">
          <Check size={14} />
          {t('desktop.permissionGranted')}
        </span>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={onGrant}>
          {t('desktop.grantPermission')}
        </Button>
      )}
    </div>
  );
}

function ServerPicker({
  current,
  busy,
  t,
  onSelect,
}: {
  current: string;
  busy: boolean;
  t: ReturnType<typeof useT>;
  onSelect: (url: string) => void;
}) {
  /**
   * The one server every build can name: the API's default local port (the shell's
   * own first-run default). Any deployed instance is entered as a custom origin.
   */
  const serverPresets = [{ value: 'http://localhost:3000', label: t('desktop.localApi') }];
  const isPreset = serverPresets.some((preset) => preset.value === current);
  const [custom, setCustom] = useState(isPreset ? '' : current);

  return (
    <Card className="space-y-3 p-4">
      <Select
        value={isPreset ? current : '__custom'}
        disabled={busy}
        onChange={(event) => {
          const value = event.target.value;
          if (value !== '__custom') onSelect(value);
        }}
      >
        {serverPresets.map((preset) => (
          <option key={preset.value} value={preset.value}>
            {preset.label}
          </option>
        ))}
        <option value="__custom">{t('desktop.customServer')}</option>
      </Select>

      {!isPreset && (
        <div className="flex gap-2">
          <Input
            value={custom}
            placeholder="https://host:port"
            disabled={busy}
            onChange={(event) => setCustom(event.target.value)}
          />
          <Button size="sm" disabled={busy || !custom.trim()} onClick={() => onSelect(custom.trim())}>
            {t('desktop.switchServer')}
          </Button>
        </div>
      )}

      <p className="text-xs text-fg-faint">
        {t('desktop.currentServer')} <code>{current}</code>
      </p>
    </Card>
  );
}

/** Explain where the running interface came from, including a rollback. */
function describeBundle(
  info: DesktopInfo,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const bundle = info.activeBundle;
  if (bundle.kind === 'staged') return t('desktop.hotUpdateBundle');
  switch (bundle.reason) {
    case 'rolled_back_after_failed_boot':
      return t('desktop.builtinRolledBack', { version: bundle.rolledBackFrom ?? info.webBundleVersion });
    case 'bundle_missing':
      return t('desktop.builtinBundleMissing');
    case 'pointer_unreadable':
      return t('desktop.builtinPointerUnreadable');
    case 'no_pointer':
    default:
      return t('desktop.builtinVersion');
  }
}
