/**
 * The member's computer phase — what they read, mapped from the server's
 * `ComputerStatusView`. `ComputerPhase`, `computerPhase` and
 * `isTransientPhase` are verbatim copies of the web's
 * (apps/web/src/components/bots/computer-phase.tsx; ./vendor.parity.test.ts
 * fails when they drift). `phaseLabelKey` and `reasonKey` are hand ports onto
 * this app's catalog (pinned by a tripwire in the same test).
 */

import type { ComputerRuntimeView, ComputerStatusView } from '../../shared/bots';
import type { TranslationKey } from '../../lib/i18n';

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

/** The status line under the computer page's title (web: `phaseLabelKey`). */
export function phaseLabelKey(phase: ComputerPhase): TranslationKey {
  switch (phase.kind) {
    case 'unavailable':
      return 'bots.computer.stateUnavailable';
    case 'checking':
      return 'bots.computer.stateChecking';
    case 'asleep':
      return 'bots.computer.stateAsleep';
    case 'starting':
      return 'bots.computer.stateStarting';
    case 'queued':
      return 'bots.computer.stateQueued';
    case 'running':
      return phase.controller === 'user' ? 'bots.computer.stateInControl' : 'bots.computer.stateRunning';
    case 'stopping':
      return 'bots.computer.stateStopping';
    case 'error':
      return 'bots.computer.stateError';
  }
}

// Reason codes are machine-readable (apps/api/src/bots/computer); the member
// reads a sentence. The web keeps one line per operator-facing precheck too —
// on the phone those all read "not available right now" (`null` → generic).
const REASON_KEYS: Record<string, TranslationKey> = {
  oom: 'bots.computer.reasonOom',
  exited: 'bots.computer.reasonExited',
  interrupted: 'bots.computer.reasonInterrupted',
  start_interrupted: 'bots.computer.reasonInterrupted',
  start_failed: 'bots.computer.reasonStartFailed',
  over_quota: 'bots.computer.reasonDiskFull',
  idle: 'bots.computer.reasonIdle',
  lru: 'bots.computer.reasonLru',
  provider_timeout: 'bots.computer.reasonStartFailed',
  move_failed: 'bots.computer.reasonStartFailed',
  restore_failed: 'bots.computer.reasonStartFailed',
};

export function reasonKey(reason: string | null | undefined): TranslationKey | null {
  if (!reason) return null;
  return REASON_KEYS[reason] ?? null;
}
