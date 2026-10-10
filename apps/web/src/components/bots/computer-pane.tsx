/**
 * ComputerPane — the member's computer beside a Bots conversation: status,
 * the live screen, take over / hand back, and the typing helpers.
 *
 * One computer per member, shared by all of their Bots (and their sign-ins).
 * The pane never decides who may operate it — the server holds the lease and
 * filters input — it only makes the current state obvious and the next step
 * one click away:
 *   unavailable → explain (team) / link to the fix (super)
 *   asleep      → Start now (it also wakes by itself when a Bot needs it)
 *   starting / queued / stopping → progress, with the queue position
 *   running     → watch (view only) → Take over → in control → Done, hand back
 *   error       → reason + Start again
 *
 * While it runs the pane has four tabs: Screen (the above, plus "Back to the
 * browser"), Terminal, Files and Processes — the last three are the Bots'
 * sandbox and need no take-over. A tab stays mounted once opened (hidden when
 * another one shows), so the live screen keeps its connection (and a held
 * lease its viewer heartbeat), the shell its scrollback and an upload its
 * progress while the member looks elsewhere.
 *
 * Hosts mount it with `{open, onClose, sessionId?, focus?}`; `onFocusChange`
 * and `busyBotName` are optional refinements (focus layout on takeover, a
 * named takeover confirmation). A host that already keeps the computer status
 * passes it as `computer` (one poller, one truth), and closes the pane through
 * the ref's `requestClose` so the hand-back guard covers every way out.
 * Design: spec §6.4, §9, design-review R11/R19.
 */

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ComputerErrorCode } from '@greenhouse/types/bots';
import { Button, ConfirmDialog, EmptyState, IconButton, Skeleton, Spinner, Tabs, toast } from '../ui';
import {
  Activity,
  AlertTriangle,
  Folder,
  History,
  Maximize2,
  Minimize2,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  SquareTerminal,
  X,
  type LucideIcon,
} from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { useAuthStore } from '../../stores/auth-store';
import {
  copyForCode,
  handbackComputer,
  isBotsApiError,
  resetComputer,
  restoreComputerWindow,
  stopComputer,
  takeoverComputer,
  typeIntoComputer,
} from '../../lib/api/bots';
import { ComputerStatusDot, phaseLabelKey, useComputerStatus, type ComputerStatusState } from './computer-phase';
import { ComputerScreen, type ComputerScreenHandle } from './computer-screen';
import { ComputerControlBar, ComputerTypePanel, ComputerWatchBar } from './computer-controls';
import { ComputerResetDialog } from './computer-reset-dialog';
import { ComputerPhasePanel } from './computer-phase-panel';
import { NeedsYouBanner, usePendingRequest } from './computer-needs-you';
import { ComputerTerminal } from './computer-terminal';
import { ComputerFiles } from './computer-files';
import { ComputerProcesses } from './computer-processes';

export interface ComputerPaneProps {
  open: boolean;
  onClose: () => void;
  /** The conversation beside the pane; its pending take-over / sign-in request is offered here. */
  sessionId?: string;
  /** Focus layout: the host gives the pane the main area, so the screen fills it. */
  focus?: boolean;
  /** Host-controlled focus layout. When given, the pane shows the toggle and enters focus on take over. */
  onFocusChange?: (focus: boolean) => void;
  /** A Bot the host knows is mid-turn — named in the take-over confirmation. */
  busyBotName?: string | null;
  /**
   * The host's computer status (`useComputerStatus`), when it already keeps
   * one — the Bots page does, for the header's state dot. Sharing it means one
   * fetch/WS listener/poll per tab, and the header and the pane always agree
   * (an action's result, or a start in flight, updates both at once). Without
   * it the pane keeps its own.
   */
  computer?: ComputerStatusState;
}

/**
 * What the host may ask of an open pane. Every way of closing it — its own ✕,
 * the host's header toggles, switching to another side pane — goes through
 * `requestClose`, so the "hand back before closing?" guard has one code path
 * and hands back exactly the request the member took over from.
 */
export interface ComputerPaneHandle {
  /** Close, unless the member holds control: then confirm and hand back first. `onClosed` runs once it may close. */
  requestClose: (onClosed: () => void) => void;
}

type Translate = ReturnType<typeof useT>;

// Every code a computer route answers with, as a sentence the member can act
// on (`satisfies` keeps the map complete when the server adds one); an
// unknown code from a newer server gets the action's own fallback line.
const ERROR_KEYS: Partial<Record<ComputerErrorCode, TranslationKey>> = {
  busy: 'botsComputer.reason_queueTimeout',
  disabled: 'botsComputer.err_unavailable',
  unavailable: 'botsComputer.err_unavailable',
  start_failed: 'botsComputer.reason_startFailed',
  stopped: 'botsComputer.err_notRunning',
  // The member's own home is full (reason `host_disk` = the server's disk: see below).
  over_quota: 'botsComputer.err_overQuota',
  user_in_control: 'botsComputer.err_userInControl',
  lease_required: 'botsComputer.err_notInControl',
  invalid: 'botsComputer.err_invalid',
  // Files and processes: the thing asked for is gone, or a transfer is over the cap.
  not_found: 'botsComputer.err_notFound',
  too_large: 'botsComputer.err_tooLarge',
} satisfies Record<ComputerErrorCode, TranslationKey>;

/** The sentence for a computer route's failure code, or null when the code is not one every route shares. */
export function computerErrorKey(err: unknown): TranslationKey | null {
  // The Docker host's disk is nearly full: no computer starts — an admin's job,
  // nothing the member can clean up on their own computer.
  if (isBotsApiError(err, 'over_quota') && err.reason === 'host_disk') return 'botsComputer.err_hostDisk';
  return copyForCode(ERROR_KEYS, isBotsApiError(err) ? err.code : null) ?? null;
}

export function computerErrorText(t: Translate, err: unknown, fallback: TranslationKey): string {
  return t(computerErrorKey(err) ?? fallback);
}

export const ComputerPane = forwardRef<ComputerPaneHandle, ComputerPaneProps>(function ComputerPane(props, ref) {
  if (!props.open) return null;
  return <ComputerPaneBody {...props} ref={ref} />;
});

type BusyAction = 'start' | 'takeover' | 'handback' | 'sleep' | 'reset' | 'restore';

export type ComputerTab = 'screen' | 'terminal' | 'files' | 'processes';

const TABS: ReadonlyArray<{ key: ComputerTab; label: TranslationKey; icon: LucideIcon }> = [
  { key: 'screen', label: 'botsComputer.tab_screen', icon: Monitor },
  { key: 'terminal', label: 'botsComputer.tab_terminal', icon: SquareTerminal },
  { key: 'files', label: 'botsComputer.tab_files', icon: Folder },
  { key: 'processes', label: 'botsComputer.tab_processes', icon: Activity },
];

function asTab(key: string): ComputerTab {
  return TABS.find((tab) => tab.key === key)?.key ?? 'screen';
}

const ComputerPaneBody = forwardRef<ComputerPaneHandle, ComputerPaneProps>(function ComputerPaneBody(
  { onClose, sessionId, focus = false, onFocusChange, busyBotName, computer: shared },
  ref,
) {
  const t = useT();
  const isSuper = useAuthStore((s) => s.currentUser?.role === 'super');
  const rootRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<ComputerScreenHandle>(null);
  // Disabled when the host shares its own: no second fetch, listener or poll.
  const own = useComputerStatus(!shared);
  const computer = shared ?? own;
  const { status, phase } = computer;
  const fullscreen = useFullscreen(rootRef);
  const { pending, reload: reloadPending } = usePendingRequest(sessionId);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  // Set while "hand back before closing?" is open: what to do once it may close.
  const [closeThen, setCloseThen] = useState<(() => void) | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [typePanel, setTypePanel] = useState<{ masked: boolean; pasteFallback: boolean } | null>(null);
  const [pasting, setPasting] = useState(false);
  // The request a take-over answers, so handing back resumes exactly that Bot.
  const [answering, setAnswering] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<ComputerTab>('screen');
  /** The restored-from-backup notice the member closed (it stays closed for that backup). */
  const [dismissedRestore, setDismissedRestore] = useState<string | null>(null);
  // Tabs opened so far stay mounted (hidden) — see the header comment.
  const [opened, setOpened] = useState<ReadonlySet<ComputerTab>>(() => new Set<ComputerTab>(['screen']));
  const showTab = useCallback((next: ComputerTab) => {
    setTab(next);
    setOpened((current) => (current.has(next) ? current : new Set(current).add(next)));
  }, []);

  const inControl = phase?.kind === 'running' && phase.controller === 'user';
  const expanded = focus || fullscreen.active;

  useEffect(() => {
    if (!inControl) setTypePanel(null);
  }, [inControl]);

  const takeOver = async (requestId?: string) => {
    setConfirmTakeover(false);
    setBusy('takeover');
    showTab('screen');
    try {
      computer.apply(await takeoverComputer());
      setAnswering(requestId);
      onFocusChange?.(true);
      screenRef.current?.focus();
      void reloadPending();
    } catch (err) {
      toast(computerErrorText(t, err, 'botsComputer.takeOverFailed'), 'error');
      void computer.refresh();
    } finally {
      setBusy(null);
    }
  };

  const requestTakeOver = (requestId?: string) => {
    // Confirm only when the host knows a Bot is mid-turn. `last_active_at` is no
    // signal: watching the screen keeps it fresh. A Bot that asked for help is
    // waiting, not working — no confirmation then either.
    if (!requestId && busyBotName) {
      setConfirmTakeover(true);
      return;
    }
    void takeOver(requestId);
  };

  /**
   * Give the computer back. The server settles the card this answers — the
   * one taken over from (or `requestId`), else the single one waiting in this
   * conversation — and wakes its Bot.
   */
  const handBack = async (note: string, requestId?: string): Promise<boolean> => {
    setBusy('handback');
    try {
      computer.apply(await handbackComputer({ note, requestId: requestId ?? answering, sessionId }));
      setAnswering(undefined);
      onFocusChange?.(false);
      if (fullscreen.active) void fullscreen.toggle();
      toast(t('botsComputer.handedBack'), 'success');
      void reloadPending();
      return true;
    } catch (err) {
      toast(computerErrorText(t, err, 'botsComputer.handBackFailed'), 'error');
      void computer.refresh();
      return false;
    } finally {
      setBusy(null);
    }
  };

  const typeText = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await typeIntoComputer(text);
        return true;
      } catch (err) {
        toast(computerErrorText(t, err, 'botsComputer.typeFailed'), 'error');
        return false;
      }
    },
    [t],
  );

  const paste = async () => {
    let text: string | null;
    try {
      text = navigator.clipboard?.readText ? await navigator.clipboard.readText() : null;
    } catch {
      text = null; // permission denied / insecure context
    }
    if (text === null) {
      setTypePanel({ masked: true, pasteFallback: true });
      return;
    }
    if (!text) {
      toast(t('botsComputer.pasteEmpty'), 'info');
      return;
    }
    setPasting(true);
    if (await typeText(text)) toast(t('botsComputer.typeSent'), 'success');
    setPasting(false);
  };

  const start = async () => {
    setBusy('start');
    try {
      await computer.start();
    } catch (err) {
      toast(computerErrorText(t, err, 'botsComputer.startFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const sleep = async () => {
    setBusy('sleep');
    try {
      computer.apply(await stopComputer());
    } catch (err) {
      toast(computerErrorText(t, err, 'botsComputer.sleepFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  /** Minimised or closed the browser window? Bring it back (no lease needed). */
  const restoreWindow = async () => {
    setBusy('restore');
    try {
      await restoreComputerWindow();
    } catch (err) {
      toast(computerErrorText(t, err, 'botsComputer.restoreWindowFailed'), 'error');
      void computer.refresh();
    } finally {
      setBusy(null);
    }
  };

  const reset = async (wipeData: boolean) => {
    setBusy('reset');
    try {
      computer.apply(await resetComputer(wipeData));
      setResetOpen(false);
      toast(t('botsComputer.resetDone'), 'success');
    } catch (err) {
      toast(computerErrorText(t, err, 'botsComputer.resetFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const requestClose = useCallback(
    (onClosed: () => void) => {
      // Wrapped: a bare function passed to a state setter would be called as an updater.
      if (inControl) setCloseThen(() => onClosed);
      else onClosed();
    },
    [inControl],
  );
  useImperativeHandle(ref, () => ({ requestClose }), [requestClose]);

  const showBanner = pending && !inControl && phase?.kind !== 'unavailable';

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 w-full flex-col bg-surface-canvas"
      data-testid="computer-pane"
      data-phase={phase?.kind ?? 'loading'}
    >
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5">
        <Monitor size={16} className="flex-shrink-0 text-primary-fg" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-fg">{t('botsComputer.title')}</h2>
        {phase && (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted" data-testid="computer-state">
            <ComputerStatusDot phase={phase} />
            <span className="truncate" title={t(phaseLabelKey(phase))}>
              {t(phaseLabelKey(phase))}
            </span>
          </span>
        )}
        <div className="ml-auto flex flex-shrink-0 items-center">
          {onFocusChange && phase?.kind === 'running' && (
            <IconButton
              label={focus ? t('botsComputer.exitFocusLayout') : t('botsComputer.focusLayout')}
              onClick={() => onFocusChange(!focus)}
              aria-pressed={focus}
            >
              {focus ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </IconButton>
          )}
          {fullscreen.supported && phase?.kind === 'running' && (
            <IconButton
              label={fullscreen.active ? t('botsComputer.exitFullscreen') : t('botsComputer.fullscreen')}
              onClick={() => void fullscreen.toggle()}
            >
              {fullscreen.active ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </IconButton>
          )}
          <IconButton label={t('botsComputer.close')} onClick={() => requestClose(onClose)}>
            <X size={16} />
          </IconButton>
        </div>
      </header>

      <div className={`flex min-h-0 flex-1 flex-col gap-3 p-3 ${expanded ? '' : 'overflow-y-auto'}`}>
        {showBanner && pending && (
          <NeedsYouBanner
            request={pending.request}
            botName={pending.botName}
            busy={busy === 'takeover' || busy === 'handback'}
            canTakeOver={phase?.kind === 'running'}
            onTakeOver={() => requestTakeOver(pending.request.id)}
            onContinue={() => void handBack('', pending.request.id)}
          />
        )}

        {!status ? (
          computer.loadError ? (
            <EmptyState
              variant="compact"
              tone="danger"
              icon={AlertTriangle}
              title={t('botsComputer.loadFailed')}
              action={
                <Button size="sm" variant="outline" onClick={() => void computer.refresh()}>
                  {t('botsComputer.retry')}
                </Button>
              }
            />
          ) : (
            <div className="space-y-2" role="status" aria-label={t('botsComputer.state_loading')}>
              <Skeleton className="aspect-[16/10] w-full rounded-lg" />
              <Skeleton className="h-8 w-full" />
            </div>
          )
        ) : phase?.kind === 'running' ? (
          <>
            {status.restored_from && dismissedRestore !== status.restored_from && (
              <div
                className="flex items-start gap-2 rounded-lg border border-edge bg-surface-raised px-3 py-2 text-xs text-fg-secondary"
                role="status"
                data-testid="computer-restored"
              >
                <History size={14} className="mt-0.5 flex-shrink-0 text-primary-fg" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {t('botsComputer.restoredFrom', { when: new Date(status.restored_from).toLocaleString() })}
                </span>
                <IconButton
                  label={t('botsComputer.restoredDismiss')}
                  onClick={() => setDismissedRestore(status.restored_from)}
                >
                  <X size={14} />
                </IconButton>
              </div>
            )}
            <Tabs
              ariaLabel={t('botsComputer.tabsLabel')}
              active={tab}
              onChange={(key) => showTab(asTab(key))}
              tabs={TABS.map(({ key, label, icon: Icon }) => ({
                key,
                testId: `computer-tab-${key}`,
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon size={14} className="hidden sm:inline-block" aria-hidden="true" />
                    {t(label)}
                  </span>
                ),
              }))}
            />
            <div
              role="tabpanel"
              aria-label={t('botsComputer.tab_screen')}
              hidden={tab !== 'screen'}
              className={`flex flex-col gap-3 ${expanded ? 'min-h-0 flex-1' : ''}`}
            >
              <ComputerScreen
                ref={screenRef}
                viewOnly={!inControl}
                onTakeOver={() => requestTakeOver(pending?.request.id)}
                onDisconnected={() => void computer.refresh()}
                className={expanded ? 'min-h-[240px] flex-1' : 'aspect-[16/10] w-full flex-shrink-0'}
              />
              {inControl ? (
                <ComputerControlBar
                  since={phase.since}
                  busy={busy === 'handback'}
                  typeOpen={typePanel !== null}
                  pasting={pasting}
                  onToggleType={() => setTypePanel((open) => (open ? null : { masked: false, pasteFallback: false }))}
                  onPaste={() => void paste()}
                  onHandBack={(note) => void handBack(note)}
                  restoring={busy === 'restore'}
                  onRestoreWindow={() => void restoreWindow()}
                >
                  {typePanel && (
                    <ComputerTypePanel
                      initiallyMasked={typePanel.masked}
                      pasteFallback={typePanel.pasteFallback}
                      onSubmit={typeText}
                      onKey={(key) => screenRef.current?.sendKey(key)}
                    />
                  )}
                </ComputerControlBar>
              ) : (
                <ComputerWatchBar
                  busy={busy === 'takeover'}
                  onTakeOver={() => requestTakeOver(pending?.request.id)}
                  restoring={busy === 'restore'}
                  onRestoreWindow={() => void restoreWindow()}
                />
              )}
            </div>
            {opened.has('terminal') && (
              <div
                role="tabpanel"
                aria-label={t('botsComputer.tab_terminal')}
                hidden={tab !== 'terminal'}
                className="flex min-h-0 flex-1 flex-col"
              >
                <ComputerTerminal active={tab === 'terminal'} onDisconnected={() => void computer.refresh()} />
              </div>
            )}
            {opened.has('files') && (
              <div
                role="tabpanel"
                aria-label={t('botsComputer.tab_files')}
                hidden={tab !== 'files'}
                className="flex min-h-0 flex-1 flex-col"
              >
                <ComputerFiles active={tab === 'files'} onStale={() => void computer.refresh()} />
              </div>
            )}
            {opened.has('processes') && (
              <div
                role="tabpanel"
                aria-label={t('botsComputer.tab_processes')}
                hidden={tab !== 'processes'}
                className="flex min-h-0 flex-1 flex-col"
              >
                <ComputerProcesses active={tab === 'processes'} onStale={() => void computer.refresh()} />
              </div>
            )}
          </>
        ) : (
          phase && (
            <ComputerPhasePanel
              phase={phase}
              isSuper={isSuper}
              starting={busy === 'start'}
              onStart={() => void start()}
            />
          )
        )}
      </div>

      {status && phase && phase.kind !== 'unavailable' && (
        <footer className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-edge px-3 py-2">
          <p className="min-w-0 flex-1 text-[11px] leading-4 text-fg-faint">{t('botsComputer.sharedNote')}</p>
          {phase.kind === 'running' && !inControl && (
            <Button size="sm" variant="ghost" onClick={() => void sleep()} disabled={busy !== null}>
              {busy === 'sleep' && <Spinner className="mr-1" />}
              {t('botsComputer.sleep')}
            </Button>
          )}
          {(phase.kind === 'running' || phase.kind === 'asleep' || phase.kind === 'error') && (
            <Button size="sm" variant="ghost" onClick={() => setResetOpen(true)} disabled={busy !== null}>
              {t('botsComputer.reset')}
            </Button>
          )}
        </footer>
      )}

      <ConfirmDialog
        open={confirmTakeover}
        onClose={() => setConfirmTakeover(false)}
        onConfirm={() => void takeOver()}
        title={t('botsComputer.takeOverConfirmTitle')}
        description={t('botsComputer.takeOverConfirmBusy', { name: busyBotName ?? '' })}
        confirmLabel={t('botsComputer.takeOver')}
      />
      <ConfirmDialog
        open={closeThen !== null}
        onClose={() => setCloseThen(null)}
        onConfirm={async () => {
          const then = closeThen;
          setCloseThen(null);
          // Handing back failed (toast already shown): the pane stays open, the member keeps control.
          if (then && (await handBack(''))) then();
        }}
        title={t('botsComputer.closeInControlTitle')}
        description={t('botsComputer.closeInControlDesc')}
        confirmLabel={t('botsComputer.closeInControlConfirm')}
      />
      <ComputerResetDialog
        open={resetOpen}
        title={t('botsComputer.resetTitle')}
        busy={busy === 'reset'}
        onClose={() => setResetOpen(false)}
        onConfirm={(wipe) => void reset(wipe)}
      />
    </div>
  );
});

// ─── Fullscreen ──────────────────────────────────────────

function useFullscreen(ref: React.RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);
  const supported = typeof document !== 'undefined' && document.fullscreenEnabled === true;

  useEffect(() => {
    const onChange = () => setActive(document.fullscreenElement !== null && document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [ref]);

  const toggle = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await ref.current?.requestFullscreen();
    } catch {
      // Denied (iframe policy, no user gesture) — the button simply does nothing.
    }
  }, [ref]);

  return { supported, active, toggle };
}
