import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, MonitorDown, RefreshCw, ScrollText } from '../../lib/icons';
import { isDesktop } from '../../lib/desktop/bridge';
import { installShellUpdateAndRestart, restartApp } from '../../lib/desktop/updates';
import type { WebReleaseNotes } from '../../lib/desktop/types';
import { useDesktopUpdateStore } from '../../stores/desktop-update-store';
import { Button, Dialog, IconButton, toast } from '../ui';
import { useT } from '../../lib/i18n';

export function DesktopUpdateNotice({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const pending = useDesktopUpdateStore((state) => state.pending);
  const currentReleaseNotes = useDesktopUpdateStore((state) => state.currentReleaseNotes);
  const releaseNotesHistory = useDesktopUpdateStore((state) => state.releaseNotesHistory);
  const requiredShellVersion = useDesktopUpdateStore((state) => state.requiredShellVersion);
  const shellReadyVersion = useDesktopUpdateStore((state) => state.shellReadyVersion);
  const releaseNotesOpen = useDesktopUpdateStore((state) => state.releaseNotesOpen);
  const setReleaseNotesOpen = useDesktopUpdateStore((state) => state.setReleaseNotesOpen);

  const notes = pending?.releaseNotes ?? currentReleaseNotes;
  const notesTimeline = useMemo(
    () => mergeReleaseNotesTimeline(notes, releaseNotesHistory),
    [notes, releaseNotesHistory],
  );
  const desktop = isDesktop();
  const versionLabel = pending?.releaseNotes
    ? `v${pending.releaseNotes.appVersion}`
    : pending
      ? t('desktop.interfaceVersion', { version: pending.version })
      : null;

  // A restart applies both lines at once, so a downloaded shell supersedes the web
  // prompt rather than stacking a second card beside it.
  return (
    <>
      {desktop &&
        pending &&
        !shellReadyVersion &&
        (compact ? (
          <button
            type="button"
            onClick={() => void restartApp()}
            className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg bg-primary-subtle text-primary-fg-strong transition-colors hover:bg-primary-subtle-hover"
            title={t('desktop.updateReadyRestart', { version: versionLabel ?? '' })}
            aria-label={t('desktop.updateReadyRestart', { version: versionLabel ?? '' })}
          >
            <Download size={16} />
          </button>
        ) : (
          <div className="mx-3 mb-2 rounded-lg border border-primary-edge bg-primary-subtle p-2.5">
            <div className="flex items-start gap-2">
              <Download size={15} className="mt-0.5 flex-shrink-0 text-primary-fg-strong" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-primary-fg-strong">
                  {t('desktop.updateReady', { version: versionLabel ?? '' })}
                </div>
                <div className="mt-0.5 text-[11px] leading-4 text-fg-muted">{t('desktop.restartToUpgrade')}</div>
                <div className="mt-2 flex items-center gap-1">
                  {notes && (
                    <button
                      type="button"
                      onClick={() => setReleaseNotesOpen(true)}
                      className="rounded px-1.5 py-1 text-[11px] text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg"
                    >
                      {t('desktop.releaseNotes')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void restartApp()}
                    className="rounded bg-primary-600 px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-primary-700"
                  >
                    {t('desktop.restartNow')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}

      {/* Either the shell is downloaded and one restart away, or a newer web bundle
          needs one this shell hasn't got yet. Both end at the same button. */}
      {desktop && (shellReadyVersion || (!pending && requiredShellVersion)) && (
        <ShellUpdateNotice compact={compact} ready={shellReadyVersion} required={requiredShellVersion} />
      )}

      <ReleaseNotesDialog
        notes={notesTimeline}
        pendingVersion={pending?.releaseNotes?.webBundleVersion ?? null}
        restartPending={Boolean(pending)}
        open={releaseNotesOpen}
        onClose={() => setReleaseNotesOpen(false)}
      />
    </>
  );
}

/**
 * One card, two states.
 *
 * `ready` — the background pass already downloaded the shell, so this is a restart
 * and nothing else. `required` without `ready` — a web bundle needs a newer shell
 * that isn't here yet (the background pass hasn't run, or failed), so the click has
 * to do the download too. Same button either way; only the promise it makes differs.
 */
function ShellUpdateNotice({
  compact,
  ready,
  required,
}: {
  compact: boolean;
  ready: string | null;
  required: string | null;
}) {
  const t = useT();
  const shellInstalling = useDesktopUpdateStore((state) => state.shellInstalling);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    setError(null);
    try {
      const outcome = await installShellUpdateAndRestart();
      if (outcome === 'not_ready') toast(t('desktop.shellNotReady'), 'info');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const title = ready ? t('desktop.shellReady', { version: `v${ready}` }) : t('desktop.shellUpdateRequired');
  const busyLabel = ready ? t('desktop.installing') : t('desktop.installingShell');

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        disabled={shellInstalling}
        className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg bg-primary-subtle text-primary-fg-strong transition-colors hover:bg-primary-subtle-hover disabled:opacity-60"
        title={shellInstalling ? busyLabel : title}
        aria-label={t('desktop.updateDesktopApp')}
      >
        <MonitorDown size={16} />
      </button>
    );
  }

  return (
    <div className="mx-3 mb-2 rounded-lg border border-primary-edge bg-primary-subtle p-2.5">
      <div className="flex items-start gap-2">
        <MonitorDown size={15} className="mt-0.5 flex-shrink-0 text-primary-fg-strong" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-primary-fg-strong">{title}</div>
          <div className="mt-0.5 text-[11px] leading-4 text-fg-muted">
            {ready ? t('desktop.restartToUpgrade') : t('desktop.shellVersionRequired', { version: required ?? '' })}
          </div>
          {error && (
            <div className="mt-1 text-[11px] leading-4 text-danger">
              {t('desktop.autoUpdateFailed', { error })}
              <span className="text-fg-faint">{t('desktop.manualUpdateHint')}</span>
            </div>
          )}
          <div className="mt-2">
            <button
              type="button"
              onClick={() => void install()}
              disabled={shellInstalling}
              className="rounded bg-primary-600 px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-primary-700 disabled:opacity-60"
            >
              {shellInstalling
                ? busyLabel
                : error
                  ? t('desktop.retry')
                  : ready
                    ? t('desktop.restartUpgrade')
                    : t('desktop.autoUpdateRestart')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function mergeReleaseNotesTimeline(
  primary: WebReleaseNotes | null,
  history: WebReleaseNotes[],
): WebReleaseNotes[] {
  const byVersion = new Map<string, WebReleaseNotes>();
  for (const notes of [primary, ...history]) {
    if (notes && !byVersion.has(notes.webBundleVersion)) byVersion.set(notes.webBundleVersion, notes);
  }
  return [...byVersion.values()].sort((left, right) => Number(right.webBundleVersion) - Number(left.webBundleVersion));
}

export function ReleaseNotesDialog({
  notes,
  pendingVersion,
  restartPending,
  open,
  onClose,
}: {
  notes: WebReleaseNotes[];
  pendingVersion: string | null;
  restartPending: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const newestVersion = notes[0]?.webBundleVersion ?? null;
  useEffect(() => {
    if (open) setSelectedIndex(0);
  }, [open, newestVersion]);
  const selectedNotes = notes[selectedIndex] ?? null;
  const hasOlder = selectedIndex < notes.length - 1;
  const hasNewer = selectedIndex > 0;
  const headerActions =
    notes.length > 1 ? (
      <div className="flex items-center gap-0.5">
        <IconButton
          label={t('desktop.olderRelease')}
          size="compact"
          tooltipMode="portal"
          onClick={() => setSelectedIndex((index) => Math.min(index + 1, notes.length - 1))}
          disabled={!hasOlder}
        >
          <ChevronLeft size={15} />
        </IconButton>
        <IconButton
          label={t('desktop.newerRelease')}
          size="compact"
          tooltipMode="portal"
          onClick={() => setSelectedIndex((index) => Math.max(index - 1, 0))}
          disabled={!hasNewer}
        >
          <ChevronRight size={15} />
        </IconButton>
      </div>
    ) : undefined;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('desktop.releaseNotes')}
      size="workspace"
      scrollBody={false}
      headerActions={headerActions}
    >
      <div className="flex h-[min(42rem,calc(100dvh-10rem))] min-h-0 flex-col">
        {selectedNotes ? (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
            <div className="flex items-center gap-2 text-xs text-fg-faint">
              <span>v{selectedNotes.appVersion}</span>
              {selectedNotes.webBundleVersion === pendingVersion && (
                <span className="rounded-full bg-primary-subtle px-2 py-0.5 text-primary-fg-strong">
                  {t('desktop.pendingRestart')}
                </span>
              )}
            </div>
            <h4 className="mt-2 text-base font-semibold text-fg">{selectedNotes.title}</h4>
            <p className="mt-1 text-sm leading-6 text-fg-muted">{selectedNotes.summary}</p>
            <ul className="mt-4 space-y-2">
              {selectedNotes.changes.map((change) => (
                <li key={change} className="flex gap-2 text-sm leading-6 text-fg-secondary">
                  <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary-500" />
                  <span>{change}</span>
                </li>
              ))}
            </ul>
            {restartPending && (
              <div className="mt-5 flex justify-end">
                <Button onClick={() => void restartApp()}>
                  <RefreshCw size={14} />
                  <span className="ml-1.5">{t('desktop.restartUpgrade')}</span>
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <ScrollText size={24} className="text-fg-faint" />
            <p className="mt-2 text-sm text-fg-muted">{t('desktop.noReleaseNotes')}</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
