/**
 * Hot-update checking.
 *
 * The engine in `apps/desktop/src-tauri/src/updater/` only runs when something asks
 * it to, so this is what makes hot updates actually reach people: a check shortly
 * after launch, then once every few hours for sessions that stay open for days.
 *
 * Staging never disturbs the running app — the new bundle takes effect on the next
 * launch, guarded by the boot watchdog. So checking in the background is safe, and
 * the user only ever sees a "restart to apply" prompt.
 */

import { toast } from '../../components/ui';
import { getStoredLocale, translate } from '../i18n';
import { publicAssetUrl } from '../api-base';
import { useDesktopUpdateStore } from '../../stores/desktop-update-store';
import { invokeDesktop, isDesktop, onDesktopEvent } from './bridge';
import { DESKTOP_EVENT } from './types';
import type {
  DownloadedInstaller,
  InstallerProgress,
  ShellUpdatePreparation,
  WebReleaseNotes,
  WebUpdateResult,
} from './types';

/**
 * Wait a little after launch before the first check: startup is already competing
 * for network with session validation and the initial page loads, and an update
 * that lands 20 seconds later is no worse than one that lands immediately.
 */
const FIRST_CHECK_DELAY_MS = 20_000;
/** Long-lived sessions are common, so keep checking. */
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let started = false;
let inFlight: Promise<WebUpdateResult> | null = null;
/** A shell download runs for minutes; a second one on the next tick is waste. */
let shellPreparation: Promise<ShellUpdatePreparation> | null = null;

/** Check once, returning the outcome. Throws if the update source is unreachable. */
export async function checkForWebUpdate(): Promise<WebUpdateResult> {
  if (inFlight) return inFlight;

  useDesktopUpdateStore.getState().setChecking(true);
  inFlight = invokeDesktop('desktop_check_web_update')
    .then((result) => {
      applyUpdateResult(result);
      return result;
    })
    .finally(() => {
      useDesktopUpdateStore.getState().setChecking(false);
      inFlight = null;
    });
  return inFlight;
}

export async function restartApp(): Promise<void> {
  await invokeDesktop('desktop_restart');
}

/**
 * Install the newer shell, then restart into it.
 *
 * Usually instant: `prepareShellUpdate` has already downloaded the payload in the
 * background, so this is a local file swap. Returns without restarting when the
 * feed has nothing newer yet — the app line of a release can land minutes after the
 * web line announced the requirement. Errors propagate to the caller; the running
 * (old) shell stays fully usable.
 */
export async function installShellUpdateAndRestart(): Promise<'restarting' | 'not_ready'> {
  const store = useDesktopUpdateStore.getState();
  store.setShellInstalling(true);
  try {
    const result = await invokeDesktop('desktop_install_shell_update');
    if (result.status !== 'installed') return 'not_ready';
    await restartApp();
    return 'restarting';
  } finally {
    useDesktopUpdateStore.getState().setShellInstalling(false);
  }
}

/**
 * Fetch a newer shell in the background, if there is one.
 *
 * This is what makes a shell update feel like a hot update: by the time anything is
 * shown to the user, the bytes are already here and all that is left is a restart.
 * It matters because the download is slow — minutes, not seconds, on the real update
 * source — so doing it while the user waits is the whole difference.
 */
export async function prepareShellUpdate(): Promise<ShellUpdatePreparation> {
  shellPreparation ??= invokeDesktop('desktop_prepare_shell_update')
    .then((result) => {
      useDesktopUpdateStore.getState().setShellReadyVersion(result.status === 'ready' ? result.version : null);
      return result;
    })
    .finally(() => {
      shellPreparation = null;
    });
  return shellPreparation;
}

/**
 * Save the published installer to Downloads so the user can install it themselves.
 *
 * The second way out of a shell update, next to `installShellUpdateAndRestart`:
 * that one is smoother, this one keeps working when it isn't (a failed install, a
 * user who would rather see the package). The shell reveals the file when it lands.
 *
 * `onProgress` receives 0…1. Worth wiring up: against the real update source this
 * takes minutes, not seconds.
 */
export async function downloadShellInstaller(onProgress?: (fraction: number) => void): Promise<DownloadedInstaller> {
  const stop = onProgress
    ? await onDesktopEvent<InstallerProgress>(DESKTOP_EVENT.installerProgress, ({ received, total }) =>
        onProgress(total > 0 ? Math.min(received / total, 1) : 0),
      )
    : () => {};
  try {
    return await invokeDesktop('desktop_download_shell_installer');
  } finally {
    stop();
  }
}

export async function checkForWebUpdateManually(): Promise<WebUpdateResult> {
  const result = await checkForWebUpdate();
  const locale = getStoredLocale();
  if (result.status === 'staged') {
    const displayVersion = result.releaseNotes
      ? `v${result.releaseNotes.appVersion}`
      : translate(locale, 'desktop.interfaceVersion', { version: result.version });
    toast(
      result.downloaded === false
        ? translate(locale, 'desktop.updateReady', { version: displayVersion })
        : translate(locale, 'desktop.updateDownloaded', { version: displayVersion }),
      'success',
    );
  } else if (result.status === 'needs_newer_shell') {
    toast(translate(locale, 'desktop.shellUpdateRequired'), 'info');
  } else {
    toast(translate(locale, 'desktop.alreadyLatest'), 'info');
  }
  return result;
}

function applyUpdateResult(result: WebUpdateResult): void {
  const store = useDesktopUpdateStore.getState();
  if (result.status === 'staged') {
    store.setPending({
      version: result.version,
      releaseNotes: result.releaseNotes ?? null,
    });
    store.setRequiredShellVersion(null);
  } else if (result.status === 'needs_newer_shell') {
    store.setRequiredShellVersion(result.required);
  }
}

export function parseReleaseNotes(value: unknown): WebReleaseNotes | null {
  if (!value || typeof value !== 'object') return null;
  const notes = value as Partial<WebReleaseNotes>;
  const valid =
    notes.schemaVersion === 1 &&
    typeof notes.appVersion === 'string' &&
    typeof notes.webBundleVersion === 'string' &&
    typeof notes.title === 'string' &&
    notes.title.trim().length > 0 &&
    [...notes.title].length <= 40 &&
    typeof notes.summary === 'string' &&
    notes.summary.trim().length > 0 &&
    [...notes.summary].length <= 100 &&
    Array.isArray(notes.changes) &&
    notes.changes.length > 0 &&
    notes.changes.length <= 6 &&
    notes.changes.every(
      (change) => typeof change === 'string' && change.trim().length > 0 && [...change].length <= 80,
    ) &&
    typeof notes.releasedAt === 'string';
  return valid ? (notes as WebReleaseNotes) : null;
}

export function parseReleaseNotesHistory(value: unknown): WebReleaseNotes[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseReleaseNotes)
    .filter((notes): notes is WebReleaseNotes => notes !== null)
    .sort((left, right) => Number(right.webBundleVersion) - Number(left.webBundleVersion));
}

export async function loadReleaseNotes(): Promise<void> {
  const load = async (filename: string): Promise<unknown | null> => {
    try {
      const response = await fetch(publicAssetUrl(filename), { cache: 'no-store' });
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  };
  const [currentValue, historyValue] = await Promise.all([
    load('release-notes.json'),
    load('release-notes-history.json'),
  ]);
  const current = parseReleaseNotes(currentValue);
  const history = parseReleaseNotesHistory(historyValue);
  const store = useDesktopUpdateStore.getState();
  if (current) store.setCurrentReleaseNotes(current);
  if (history.length > 0) store.setReleaseNotesHistory(history);
  // Older bundles have neither file. Updates still work without release notes.
}

/** Begin background update checking for this window. Safe to call more than once. */
export function startUpdateChecks(): () => void {
  if (!isDesktop() || started) return () => {};
  started = true;

  const check = async () => {
    try {
      const result = await checkForWebUpdate();
      if (result.status === 'needs_newer_shell') {
        console.info(`[desktop] a newer web bundle needs shell >= ${result.required}`);
      }
    } catch (err) {
      // Offline, or the update source is down. Nothing to tell the user — the app
      // works fine on the bundle it already has.
      console.debug('[desktop] update check failed', err);
    }

    // Then the app line, on the same schedule. Deliberately after the web check:
    // this one can run for minutes, and the hot update is the far more frequent
    // of the two.
    try {
      const shell = await prepareShellUpdate();
      if (shell.status === 'ready') {
        console.info(`[desktop] shell v${shell.version} downloaded; installs on restart`);
      }
    } catch (err) {
      console.debug('[desktop] shell update preparation failed', err);
    }
  };

  const first = window.setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
  const interval = window.setInterval(() => void check(), RECHECK_INTERVAL_MS);

  return () => {
    window.clearTimeout(first);
    window.clearInterval(interval);
    started = false;
  };
}
