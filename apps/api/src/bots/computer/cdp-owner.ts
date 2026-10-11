/**
 * DevTools ownership — which process may drive a member's browser.
 *
 * The computer's DevTools relay accepts ONE client, and the blue/green API
 * slots (each with its Runtime worker) share the member's computer: two
 * processes connecting in turn would kick each other off mid-action. So a
 * process claims the member's DevTools before it connects
 * (`tryLockCdpOwner`, a session-level advisory lock — no schema; the database
 * frees it by itself when the process dies):
 *
 * - a process that does not own it raises its hand (`setCdpWanted`) and
 *   waits up to CDP_CLAIM_WAIT_MS, polling, then gets a retryable `busy`;
 * - the owner lets go once it has gone CDP_IDLE_RELEASE_MS without browser
 *   use (no action in flight, nothing touched the connection) AND another
 *   process is waiting — re-checked every CDP_IDLE_CHECK_MS while idle — and
 *   always on purge / stop / shutdown. Nobody waiting, it keeps the
 *   connection: element refs from the last snapshot only resolve on the
 *   connection that took it, and a Bot thinking between two steps for longer
 *   than the idle period must not come back to stale refs. Letting go drops
 *   the connection first, which also closes the background contexts it
 *   created;
 * - a claim that is new to this process reports `fresh`: whatever browser
 *   contexts the computer still has then belong to no live process (a live
 *   owner is the only one connected, and a releasing owner closes its own),
 *   so the caller disposes them at once instead of waiting out the
 *   other-process grace in tab-leases.ts.
 */

import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

import { ComputerUnavailableError } from './errors.js';

export interface CdpOwnerStore {
  tryLockCdpOwner(computerId: string): Promise<boolean>;
  unlockCdpOwner(computerId: string): Promise<void>;
  setCdpWanted(computerId: string, wanted: boolean): Promise<void>;
  isCdpWanted(computerId: string): Promise<boolean>;
}

/** How long a process waits for another one to let go of a member's browser. */
export const CDP_CLAIM_WAIT_MS = 15_000;
const CDP_CLAIM_POLL_MS = 1_000;
/** The owner lets a waiting process have the browser after this long without browser use. */
export const CDP_IDLE_RELEASE_MS = 20_000;
/** While idle that long, how often the owner looks for a waiting process. */
const CDP_IDLE_CHECK_MS = 5_000;

export interface CdpOwnershipOptions {
  store(): CdpOwnerStore;
  /** Drop this process's connection to the member's browser (runs before the lock goes). */
  disconnect(computerId: string): void;
  waitMs?: number;
  pollMs?: number;
  idleMs?: number;
  checkMs?: number;
}

export interface CdpClaim {
  /** The claim is new to this process (see the module comment). */
  fresh: boolean;
}

export function createCdpOwnership(options: CdpOwnershipOptions) {
  const waitMs = options.waitMs ?? CDP_CLAIM_WAIT_MS;
  const pollMs = options.pollMs ?? CDP_CLAIM_POLL_MS;
  const idleMs = options.idleMs ?? CDP_IDLE_RELEASE_MS;
  const checkMs = options.checkMs ?? CDP_IDLE_CHECK_MS;
  const held = new Set<string>();
  const claiming = new Map<string, Promise<CdpClaim>>();
  /** Browser actions in flight per member (an owner never lets go under one). */
  const inUse = new Map<string, number>();
  const lastUse = new Map<string, number>();
  const timers = new Map<string, NodeJS.Timeout>();

  const idle = (computerId: string) => held.has(computerId) && (inUse.get(computerId) ?? 0) === 0;
  const quietFor = (computerId: string) => Date.now() - (lastUse.get(computerId) ?? 0);

  function schedule(computerId: string, delayMs: number): void {
    clearTimeout(timers.get(computerId));
    const timer = setTimeout(() => {
      timers.delete(computerId);
      if (!idle(computerId)) return; // end() re-arms it
      if (quietFor(computerId) < idleMs) schedule(computerId, idleMs - quietFor(computerId));
      else void releaseIfWanted(computerId);
    }, delayMs);
    timer.unref?.();
    timers.set(computerId, timer);
  }

  /** Idle long enough: hand the browser over if another process waits, else look again shortly. */
  async function releaseIfWanted(computerId: string): Promise<void> {
    let wanted = false;
    try {
      wanted = await options.store().isCdpWanted(computerId);
    } catch (err) {
      logger.warn('[bots-computer] DevTools waiter check failed', { user_id: computerId, error: toErrorMessage(err) });
    }
    // Used again while we asked: a new idle period starts (touch re-armed it).
    if (!idle(computerId) || quietFor(computerId) < idleMs) return;
    if (wanted) await release(computerId);
    else schedule(computerId, checkMs);
  }

  /** Best effort: a hand that fails to go up only means the owner keeps it until it stops. */
  async function setWanted(computerId: string, wanted: boolean): Promise<void> {
    try {
      await options.store().setCdpWanted(computerId, wanted);
    } catch (err) {
      logger.warn('[bots-computer] DevTools waiter signal failed', { user_id: computerId, error: toErrorMessage(err) });
    }
  }

  async function attempt(computerId: string): Promise<CdpClaim> {
    const wasHeld = held.has(computerId);
    const deadline = Date.now() + waitMs;
    let waiting = false;
    try {
      for (;;) {
        let owned: boolean;
        try {
          owned = await options.store().tryLockCdpOwner(computerId);
        } catch (err) {
          held.delete(computerId);
          logger.warn('[bots-computer] DevTools owner lock check failed', {
            user_id: computerId,
            error: toErrorMessage(err),
          });
          throw new ComputerUnavailableError('unavailable', 'Computers are unavailable on this server right now');
        }
        if (owned) {
          held.add(computerId);
          touch(computerId);
          return { fresh: !wasHeld };
        }
        // Ours a moment ago, someone else's now: the lock connection died with
        // its locks and another process claimed the browser meanwhile.
        held.delete(computerId);
        if (Date.now() >= deadline) {
          throw new ComputerUnavailableError(
            'busy',
            'Another greenhouse server is using this computer’s browser right now. Try again in a moment.',
          );
        }
        if (!waiting) {
          waiting = true;
          await setWanted(computerId, true);
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    } finally {
      if (waiting) await setWanted(computerId, false);
    }
  }

  /** Record browser use (keeps an owner from letting go for another idle period). */
  function touch(computerId: string): void {
    lastUse.set(computerId, Date.now());
    if (held.has(computerId) && (inUse.get(computerId) ?? 0) === 0) schedule(computerId, idleMs);
  }

  /** Let go of a member's browser: drop the connection, then the lock. Idempotent. */
  async function release(computerId: string): Promise<void> {
    clearTimeout(timers.get(computerId));
    timers.delete(computerId);
    if (!held.delete(computerId)) return;
    options.disconnect(computerId);
    try {
      await options.store().unlockCdpOwner(computerId);
    } catch (err) {
      // The lock goes with its connection; nothing else to do.
      logger.warn('[bots-computer] DevTools owner unlock failed', { user_id: computerId, error: toErrorMessage(err) });
    }
  }

  return {
    /**
     * Own the member's DevTools before connecting (call only when about to
     * connect: it re-checks the lock even when this process holds it). Waits
     * for another owner up to the claim timeout, then throws `busy`.
     */
    claim(computerId: string): Promise<CdpClaim> {
      const pending = claiming.get(computerId);
      if (pending) return pending;
      const next = attempt(computerId).finally(() => claiming.delete(computerId));
      claiming.set(computerId, next);
      return next;
    },
    touch,
    /** A browser action starts; call `end` in `finally`. */
    begin(computerId: string): void {
      inUse.set(computerId, (inUse.get(computerId) ?? 0) + 1);
      lastUse.set(computerId, Date.now());
    },
    end(computerId: string): void {
      const left = (inUse.get(computerId) ?? 1) - 1;
      if (left > 0) inUse.set(computerId, left);
      else inUse.delete(computerId);
      touch(computerId);
    },
    release,
    async releaseAll(): Promise<void> {
      await Promise.allSettled([...held].map((computerId) => release(computerId)));
    },
    holds(computerId: string): boolean {
      return held.has(computerId);
    },
  };
}

export type CdpOwnership = ReturnType<typeof createCdpOwnership>;
