/**
 * An Agent's computer phase: a pure mapping from the server view,
 * the copy/tone for each phase, and `useComputerStatus` — the one place that
 * keeps the view fresh (WS `bots:computer` pushes + a visibility-aware poll as
 * the safety net when the socket is down).
 *
 * Every Agent has its own computer (spec 20261011-agent-first-class P3a). A
 * computer is named by its Agent (`ComputerBot`: the Agent's id, or null for
 * the main Agent's — Sprouty's — which is the member's original computer); the
 * hook follows exactly one and ignores the pushes about the others.
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
import { isSproutyBot, type BotView, type ComputerRuntimeView, type ComputerStatusView } from '@greenhouse/types/bots';
import type { ServerWsEvent } from '@greenhouse/types/ws';
import { fetchComputerStatus, startComputer, updateComputerSettings, type ComputerBot } from '../../lib/api/bots';
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
  provider_timeout: 'botsComputer.reason_providerTimeout',
  move_failed: 'botsComputer.reason_moveFailed',
  restore_failed: 'botsComputer.reason_restoreFailed',
  egress_open: 'botsComputer.reason_egressOpen',
  docker_cli_missing: 'botsComputer.reason_dockerCliMissing',
  docker_unreachable: 'botsComputer.reason_dockerUnreachable',
  image_missing: 'botsComputer.reason_imageMissing',
  image_outdated: 'botsComputer.reason_imageOutdated',
  runtime_missing: 'botsComputer.reason_runtimeMissing',
  network_invalid: 'botsComputer.reason_networkInvalid',
  config_invalid: 'botsComputer.reason_configInvalid',
  provider_unreachable: 'botsComputer.reason_providerUnreachable',
  provider_auth: 'botsComputer.reason_providerAuth',
  provider_unsupported: 'botsComputer.reason_providerUnsupported',
  template_missing: 'botsComputer.reason_templateBuilding',
  template_building: 'botsComputer.reason_templateBuilding',
  template_failed: 'botsComputer.reason_templateFailed',
};

export function reasonKey(reason: string | null | undefined): TranslationKey | null {
  if (!reason) return null;
  return REASON_KEYS[reason] ?? null;
}

export function ComputerStatusDot({ phase, className = '' }: { phase: ComputerPhase; className?: string }) {
  const dot = phaseDot(phase);
  return <StatusDot color={dot.color} pulse={dot.pulse} className={className} />;
}

// ─── Which computer ──────────────────────────────────────

/**
 * The computer an Agent works on, as the routes name it: null for the main Agent
 * (Sprouty — its computer is the member's original one) and for no Agent at all,
 * the Agent's own id otherwise. An id the directory does not know (yet) is sent
 * as is: the server maps Sprouty to the main computer either way.
 */
export function computerBotFor(
  botId: string | null | undefined,
  lookup: (id: string) => Pick<BotView, 'template_key'> | undefined,
): ComputerBot {
  if (!botId) return null;
  const bot = lookup(botId);
  return bot && isSproutyBot(bot) ? null : botId;
}

type ComputerEvent = Extract<ServerWsEvent, { type: 'bots:computer' }>;

/**
 * Does a `bots:computer` push concern the computer this view follows? Pushes name
 * their computer (`computer_id` / `bot_id`, null = the main one); older servers sent
 * neither, and then had only the main computer. Once the view knows its own
 * `computer_id`, that is the exact match; before, the Agent is.
 */
export function computerEventMatches(
  event: Pick<ComputerEvent, 'computer_id' | 'bot_id'>,
  bot: ComputerBot,
  known: Pick<ComputerStatusView, 'computer_id' | 'bot_id'> | null,
): boolean {
  if (event.computer_id === undefined && event.bot_id === undefined) {
    return bot === null || known?.bot_id === null;
  }
  if (event.computer_id && known?.computer_id) return event.computer_id === known.computer_id;
  return (event.bot_id ?? null) === bot;
}

/**
 * Is this view (an action's result) about the computer `bot` names? Views from
 * older servers carry no Agent; the main computer comes back as null even when
 * asked for by Sprouty's own id (before the directory said who Sprouty is).
 */
function viewMatches(view: ComputerStatusView, bot: ComputerBot): boolean {
  return view.bot_id === undefined || view.bot_id === null || view.bot_id === bot;
}

// ─── useComputerStatus ───────────────────────────────────

const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 20_000;

export interface ComputerStatusState {
  /** Whose computer this is (null = the main Agent's). */
  bot: ComputerBot;
  status: ComputerStatusView | null;
  phase: ComputerPhase | null;
  /** Initial load failed (no status to show yet). */
  loadError: boolean;
  /** A start request is in flight (it can take up to ~45 s while queued). */
  starting: boolean;
  refresh: () => Promise<void>;
  /** Replace the view with a fresher one an action returned (ignored when it is another computer's). */
  apply: (next: ComputerStatusView) => void;
  start: () => Promise<void>;
}

/**
 * Follow one computer — `bot`'s (null = the main Agent's). Switching `bot` starts
 * over (no view of the previous computer lingers), and an answer about the
 * previous one arriving late is dropped.
 */
export function useComputerStatus(enabled: boolean, bot: ComputerBot = null): ComputerStatusState {
  const [state, setState] = useState<{ bot: ComputerBot; status: ComputerStatusView | null }>({
    bot,
    status: null,
  });
  const [loadError, setLoadError] = useState(false);
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);
  const current = useRef(bot);
  current.current = bot;
  // Another computer: forget the last one's view at once (render-time reset, no flash of it).
  const status = state.bot === bot ? state.status : null;
  if (state.bot !== bot) {
    setState({ bot, status: null });
    setLoadError(false);
    setStarting(false);
  }
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Store a view of `forBot`'s computer, unless the hook moved on to another one meanwhile. */
  const store = useCallback((forBot: ComputerBot, next: ComputerStatusView) => {
    if (!mounted.current || current.current !== forBot || !viewMatches(next, forBot)) return;
    setState({ bot: forBot, status: next });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchComputerStatus(bot);
      store(bot, next);
      if (mounted.current && current.current === bot) setLoadError(false);
    } catch {
      // Keep the last good view; only an empty pane turns into an error state.
      if (mounted.current && current.current === bot) setLoadError(true);
    }
  }, [bot, store]);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      store(bot, await startComputer(bot));
    } finally {
      if (mounted.current && current.current === bot) setStarting(false);
      void refresh();
    }
  }, [bot, refresh, store]);

  const apply = useCallback((next: ComputerStatusView) => store(current.current, next), [store]);

  const phase = status ? computerPhase(status, { starting }) : null;
  const transient = starting || (phase ? isTransientPhase(phase) : false);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  // Pushes about this computer: patch what the event carries at once, then
  // refetch the details (controller_since, queue position) the event does not.
  // Pushes about the member's other computers are none of this view's business.
  useEffect(() => {
    if (!enabled) return;
    return wsClient.onEvent((event) => {
      if (event.type !== 'bots:computer') return;
      if (!computerEventMatches(event, bot, statusRef.current)) return;
      setState((prev) =>
        prev.bot === bot && prev.status
          ? { bot, status: { ...prev.status, state: event.state, controller: event.controller } }
          : prev,
      );
      void refresh();
    });
  }, [enabled, bot, refresh]);

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
    bot,
    status,
    phase,
    loadError: loadError && !status,
    starting,
    refresh,
    apply,
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
 * the browser's, store the browser's (`PUT /api/bots/computer/settings`; the
 * setting applies to all of the member's computers). Quiet on failure — the
 * computer keeps the deployment default and the next page load tries again.
 */
export function useComputerTimezoneSync(computer: Pick<ComputerStatusState, 'bot' | 'status' | 'apply'>): void {
  const { bot, status, apply } = computer;
  useEffect(() => {
    if (!status || timezoneChecked) return;
    timezoneChecked = true;
    const timezone = browserTimeZone();
    if (!timezone || status.timezone === timezone) return;
    updateComputerSettings({ timezone }, bot).then(apply, () => {});
  }, [bot, status, apply]);
}
