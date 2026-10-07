/**
 * The member's computer phase: a pure mapping from the server view,
 * the copy/tone for each phase, and `useComputerStatus` — the one place that
 * keeps the view fresh (WS `bots:computer` pushes + a visibility-aware poll as
 * the safety net when the socket is down).
 *
 * The phase is what the member reads; the raw `ComputerStatusView` is what the
 * server knows. Keeping the mapping pure (`computerPhase`) makes every state of
 * the pane testable without a server.
 *
 * `useComputerTimezoneSync` keeps the computer on the member's own clock: the
 * page tells the server the browser's timezone once per page load when the
 * computer's differs (it takes effect at the next start).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComputerRuntimeView, ComputerStatusView } from '@greenhouse/types/bots';
import { fetchComputerStatus, startComputer, updateComputerSettings } from '../../lib/api/bots';
import { wsClient } from '../../lib/ws';
import type { TranslationKey } from '../../lib/i18n';
import { StatusDot } from '../ui';

export type ComputerPhase =
  | { kind: 'unavailable'; runtime: ComputerRuntimeView }
  | { kind: 'checking' }
  | { kind: 'asleep'; reason: string | null }
  | { kind: 'starting' }
  | { kind: 'queued'; position: number }
  | { kind: 'running'; controller: 'bot' | 'user'; since: string | null }
  | { kind: 'stopping' }
  | { kind: 'error'; reason: string | null };

/**
 * Map the server view to what the member sees. `starting` is the client's own
 * knowledge that it asked for a start which has not resolved yet — the server
 * may still report `absent` (or a stale `error`) for the first poll.
 */
export function computerPhase(status: ComputerStatusView, opts: { starting?: boolean } = {}): ComputerPhase {
  const { runtime } = status;
  if (runtime.state === 'disabled' || runtime.state === 'unavailable') return { kind: 'unavailable', runtime };
  if (runtime.state === 'checking') return { kind: 'checking' };
  if (status.queue_position != null) return { kind: 'queued', position: status.queue_position };
  switch (status.state) {
    case 'running':
      return { kind: 'running', controller: status.controller, since: status.controller_since };
    case 'starting':
      return { kind: 'starting' };
    case 'stopping':
      return { kind: 'stopping' };
    case 'error':
      return opts.starting ? { kind: 'starting' } : { kind: 'error', reason: status.state_reason };
    case 'absent':
    default:
      return opts.starting ? { kind: 'starting' } : { kind: 'asleep', reason: status.state_reason };
  }
}

/** Phases whose next step happens on the server within seconds — poll fast. */
export function isTransientPhase(phase: ComputerPhase): boolean {
  return phase.kind === 'starting' || phase.kind === 'queued' || phase.kind === 'stopping' || phase.kind === 'checking';
}

type DotColor = 'success' | 'warning' | 'danger' | 'info' | 'primary' | 'muted';

export function phaseDot(phase: ComputerPhase): { color: DotColor; pulse: boolean } {
  switch (phase.kind) {
    case 'running':
      return phase.controller === 'user' ? { color: 'primary', pulse: true } : { color: 'success', pulse: false };
    case 'starting':
    case 'queued':
    case 'stopping':
    case 'checking':
      return { color: 'info', pulse: true };
    case 'error':
      return { color: 'danger', pulse: false };
    case 'unavailable':
    case 'asleep':
    default:
      return { color: 'muted', pulse: false };
  }
}

/** Short status label for the pane header (and any header chip that mirrors it). */
export function phaseLabelKey(phase: ComputerPhase): TranslationKey {
  switch (phase.kind) {
    case 'unavailable':
      return 'botsComputer.state_unavailable';
    case 'checking':
      return 'botsComputer.state_checking';
    case 'asleep':
      return 'botsComputer.state_asleep';
    case 'starting':
      return 'botsComputer.state_starting';
    case 'queued':
      return 'botsComputer.state_queued';
    case 'running':
      return phase.controller === 'user' ? 'botsComputer.state_inControl' : 'botsComputer.state_running';
    case 'stopping':
      return 'botsComputer.state_stopping';
    case 'error':
      return 'botsComputer.state_error';
  }
}

// Reason codes are machine-readable (runtime prechecks and lifecycle events in
// apps/api/src/bots/computer); the member reads a sentence. Unknown codes fall
// back to a generic line. `idle` / `lru` explain a sleeping computer, not a fault.
const REASON_KEYS: Record<string, TranslationKey> = {
  oom: 'botsComputer.reason_oom',
  exited: 'botsComputer.reason_exited',
  interrupted: 'botsComputer.reason_interrupted',
  start_interrupted: 'botsComputer.reason_interrupted',
  start_failed: 'botsComputer.reason_startFailed',
  over_quota: 'botsComputer.reason_diskFull',
  idle: 'botsComputer.reason_idle',
  lru: 'botsComputer.reason_lru',
  docker_cli_missing: 'botsComputer.reason_dockerCliMissing',
  docker_unreachable: 'botsComputer.reason_dockerUnreachable',
  image_missing: 'botsComputer.reason_imageMissing',
  image_outdated: 'botsComputer.reason_imageOutdated',
  runtime_missing: 'botsComputer.reason_runtimeMissing',
  network_invalid: 'botsComputer.reason_networkInvalid',
  config_invalid: 'botsComputer.reason_configInvalid',
};

export function reasonKey(reason: string | null | undefined): TranslationKey | null {
  if (!reason) return null;
  return REASON_KEYS[reason] ?? null;
}

export function ComputerStatusDot({ phase, className = '' }: { phase: ComputerPhase; className?: string }) {
  const dot = phaseDot(phase);
  return <StatusDot color={dot.color} pulse={dot.pulse} className={className} />;
}

// ─── useComputerStatus ───────────────────────────────────

const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 20_000;

export interface ComputerStatusState {
  status: ComputerStatusView | null;
  phase: ComputerPhase | null;
  /** Initial load failed (no status to show yet). */
  loadError: boolean;
  /** A start request is in flight (it can take up to ~45 s while queued). */
  starting: boolean;
  refresh: () => Promise<void>;
  /** Replace the view with a fresher one an action returned. */
  apply: (next: ComputerStatusView) => void;
  start: () => Promise<void>;
}

export function useComputerStatus(enabled: boolean): ComputerStatusState {
  const [status, setStatus] = useState<ComputerStatusView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchComputerStatus();
      if (!mounted.current) return;
      setStatus(next);
      setLoadError(false);
    } catch {
      // Keep the last good view; only an empty pane turns into an error state.
      if (mounted.current) setLoadError(true);
    }
  }, []);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      const next = await startComputer();
      if (mounted.current) setStatus(next);
    } finally {
      if (mounted.current) setStarting(false);
      void refresh();
    }
  }, [refresh]);

  const phase = status ? computerPhase(status, { starting }) : null;
  const transient = starting || (phase ? isTransientPhase(phase) : false);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  // Pushes: patch what the event carries at once, then refetch the details
  // (controller_since, queue position) the event does not.
  useEffect(() => {
    if (!enabled) return;
    return wsClient.onEvent((event) => {
      if (event.type !== 'bots:computer') return;
      setStatus((prev) => (prev ? { ...prev, state: event.state, controller: event.controller } : prev));
      void refresh();
    });
  }, [enabled, refresh]);

  // Safety-net poll, paused while the tab is hidden: fast while the server is
  // mid-transition, slow otherwise (the WS push normally wins).
  useEffect(() => {
    if (!enabled) return;
    const interval = window.setInterval(
      () => {
        if (document.visibilityState === 'visible') void refresh();
      },
      transient ? FAST_POLL_MS : SLOW_POLL_MS,
    );
    return () => window.clearInterval(interval);
  }, [enabled, transient, refresh]);

  return {
    status,
    phase,
    loadError: loadError && !status,
    starting,
    refresh,
    apply: setStatus,
    start,
  };
}

// ─── Timezone ────────────────────────────────────────────

/** Once per page load: switching conversations (or remounting the page) asks no second time. */
let timezoneChecked = false;

/** Test-only: forget that this page load already checked. */
export function resetComputerTimezoneSyncForTest(): void {
  timezoneChecked = false;
}

/** The browser's IANA timezone, when it reports one. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * After the computer status loads: if the computer's stored timezone is not
 * the browser's, store the browser's (`PUT /api/bots/computer/settings`). Quiet
 * on failure — the computer keeps the deployment default and the next page
 * load tries again.
 */
export function useComputerTimezoneSync(computer: Pick<ComputerStatusState, 'status' | 'apply'>): void {
  const { status, apply } = computer;
  useEffect(() => {
    if (!status || timezoneChecked) return;
    timezoneChecked = true;
    const timezone = browserTimeZone();
    if (!timezone || status.timezone === timezone) return;
    updateComputerSettings({ timezone }).then(apply, () => {});
  }, [status, apply]);
}
