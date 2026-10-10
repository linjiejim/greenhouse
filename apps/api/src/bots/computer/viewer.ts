/**
 * Live viewer — WS /api/ws/computer?token=<one-time ticket> (spec §6.4).
 *
 * The browser's noVNC speaks RFB over this WebSocket; the API tunnels it to
 * Xvnc's 0600 Unix socket through `docker exec -i -u browser … socat`, so the
 * computer publishes no port. On the way in, the RFB filter (rfb-filter.ts)
 * drops keyboard/mouse/clipboard unless the member holds the take-over lease
 * — "view only" is enforced here, not in the browser.
 *
 * Per connection: the ticket is verified and consumed, the member re-read
 * (active, internal, same auth_version, `bots` feature) at open and every
 * 60 s; protocol pings every 20 s keep proxies from idling the socket out, and
 * a viewer that misses a pong is dropped (a phone that lost signal never sends
 * a TCP close; without this it would look live for ~15 minutes); the
 * viewer heartbeat goes to the DB every 20 s (idle shutdown and the lease
 * auto-release read it, from either slot); the lease is re-read every 5 s and
 * on every local change, so input follows it immediately; a slow browser
 * pauses the tunnel instead of buffering without bound. Every live viewer is
 * registered per member so suspend/purge can close them.
 */

import { Hono } from 'hono';
import { upgradeWebSocket } from '@hono/node-server';
import type { WSContext } from 'hono/ws';
import type { WebSocket as WsSocket } from 'ws';
import { getDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

import { userHasFeature } from '../../auth/features.js';
import type { ComputerProcess } from './host.js';
import { ComputerUnavailableError } from './errors.js';
import { computerLifecycleHooks } from './hooks.js';
import { onLeaseChange } from './lease-events.js';
import { RfbClientFilter } from './rfb-filter.js';
import { requireComputerRuntime } from './runtime.js';
import { verifyViewToken, type ViewTokenClaims } from './view-token.js';

const PING_MS = 20_000;
const HEARTBEAT_MS = 20_000;
const LEASE_POLL_MS = 5_000;
const REVALIDATE_MS = 60_000;
/** Pause the tunnel above this much unsent data; resume below the low mark. */
const HIGH_WATER_BYTES = 4 * 1024 * 1024;
const LOW_WATER_BYTES = 1024 * 1024;
/** Client bytes buffered while the computer starts (the RFB handshake is server-first, so little). */
const MAX_PENDING_BYTES = 64 * 1024;

/** Close codes the web client acts on (re-fetch a ticket vs. show why). */
export const VIEWER_CLOSE = {
  unauthorized: 4001,
  forbidden: 4003,
  unavailable: 4009,
  closedByServer: 4010,
  protocol: 1008,
  tunnelClosed: 1011,
} as const;

interface Viewer {
  userId: string;
  close(code: number, reason: string): void;
}

const viewers = new Map<string, Set<Viewer>>();

function register(viewer: Viewer): void {
  let set = viewers.get(viewer.userId);
  if (!set) viewers.set(viewer.userId, (set = new Set()));
  set.add(viewer);
}

function unregister(viewer: Viewer): void {
  const set = viewers.get(viewer.userId);
  if (!set) return;
  set.delete(viewer);
  if (set.size === 0) viewers.delete(viewer.userId);
}

/** Close every live viewer of a member (suspend, purge, account change). */
export function closeViewersFor(userId: string, reason = 'closed'): number {
  const set = viewers.get(userId);
  if (!set) return 0;
  const list = [...set];
  for (const viewer of list) viewer.close(VIEWER_CLOSE.closedByServer, reason);
  return list.length;
}

export function viewerCount(userId: string): number {
  return viewers.get(userId)?.size ?? 0;
}

/** Re-read the member: still allowed to watch their computer? */
async function memberStillAllowed(userId: string, authVersion: number): Promise<'ok' | 'unauthorized' | 'forbidden'> {
  const user = await getDb().users.getById(userId);
  if (!user || user.status !== 'active' || user.auth_version !== authVersion) return 'unauthorized';
  if (user.role !== 'super' && user.role !== 'team') return 'unauthorized';
  return (await userHasFeature(user.id, user.role, 'bots')) ? 'ok' : 'forbidden';
}

function rejectSocket(code: number, reason: string) {
  return {
    onOpen(_evt: Event, ws: WSContext) {
      ws.close(code, reason);
    },
  };
}

export function createComputerViewerRoutes() {
  return new Hono().get(
    '/',
    upgradeWebSocket(async (c) => {
      const claims = verifyViewToken(new URL(c.req.url).searchParams.get('token'));
      if (!claims) return rejectSocket(VIEWER_CLOSE.unauthorized, 'invalid ticket');
      const allowed = await memberStillAllowed(claims.uid, claims.av).catch(() => 'unauthorized' as const);
      if (allowed !== 'ok') {
        return rejectSocket(allowed === 'forbidden' ? VIEWER_CLOSE.forbidden : VIEWER_CLOSE.unauthorized, allowed);
      }
      return viewerSession(claims);
    }),
  );
}

/** The socket handlers of one verified viewer (exported for tests). */
export function viewerSession(claims: Pick<ViewTokenClaims, 'uid' | 'av' | 'c'>) {
  const userId = claims.uid;

  let raw: WsSocket | null = null;
  let child: ComputerProcess | null = null;
  let closed = false;
  /** Any frame or pong since the last ping proves the browser is still there. */
  let alive = true;
  let inputAllowed = false;
  let lastEpoch = -1;
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  const timers: NodeJS.Timeout[] = [];
  let unsubscribe: (() => void) | null = null;
  const filter = new RfbClientFilter(() => inputAllowed);

  const writeToServer = (buffers: Buffer[]) => {
    for (const buffer of buffers) child?.stdin?.write(buffer);
  };

  const applyLease = (controller: 'bot' | 'user', epoch: number) => {
    const wasAllowed = inputAllowed;
    inputAllowed = controller === 'user';
    lastEpoch = epoch;
    // Lease left the member mid-press: release what they were holding.
    if (wasAllowed && !inputAllowed) writeToServer(filter.releaseInput());
  };

  const viewer: Viewer = {
    userId,
    close(code, reason) {
      if (closed) return;
      try {
        raw?.close(code, reason);
      } catch {
        /* already closing */
      }
      cleanup();
    },
  };

  function cleanup(): void {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearInterval(timer);
    unsubscribe?.();
    unregister(viewer);
    if (child) {
      child.kill('SIGKILL');
      child = null;
    }
  }

  // onOpen awaits (start, heartbeat) and the socket may close meanwhile —
  // cleanup() has then already run. Every resource onOpen creates goes
  // through one of these, so nothing outlives a socket that is gone.
  function trackTimer(timer: NodeJS.Timeout): void {
    timer.unref?.();
    if (closed) clearInterval(timer);
    else timers.push(timer);
  }
  function adoptChild(tunnel: ComputerProcess): boolean {
    if (closed) {
      tunnel.kill('SIGKILL');
      return false;
    }
    child = tunnel;
    return true;
  }
  function adoptLeaseListener(stop: () => void): void {
    if (closed) stop();
    else unsubscribe = stop;
  }

  async function refreshLease(): Promise<void> {
    const row = await getDb().botComputers.get(userId);
    if (row && row.lease_epoch !== lastEpoch) applyLease(row.lease_controller, row.lease_epoch);
  }

  function pumpTunnel(tunnel: ComputerProcess, socket: WsSocket): void {
    tunnel.stdout!.on('data', (chunk: Buffer) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(chunk, { binary: true });
      if (socket.bufferedAmount > HIGH_WATER_BYTES) {
        tunnel.stdout!.pause();
        const wait = setInterval(() => {
          if (closed || socket.bufferedAmount < LOW_WATER_BYTES) {
            clearInterval(wait);
            if (!closed) tunnel.stdout!.resume();
          }
        }, 50);
      }
    });
    tunnel.stderr!.on('data', () => {});
    tunnel.on('error', () => viewer.close(VIEWER_CLOSE.tunnelClosed, 'tunnel failed'));
    tunnel.on('exit', () => viewer.close(VIEWER_CLOSE.tunnelClosed, 'computer closed'));
  }

  return {
    async onOpen(_evt: Event, ws: WSContext) {
      const socket = ws.raw as WsSocket;
      raw = socket;
      socket.on('pong', () => {
        alive = true;
      });
      register(viewer);
      const db = getDb();
      try {
        const { controller, host } = requireComputerRuntime();
        // Opening your own computer may start it, even over the soft disk
        // limit — that is how a member gets in to clean up.
        const row = await controller.ensureRunning(userId, { allowOverQuota: true });
        if (closed) return;
        if (row.container_name !== claims.c) {
          viewer.close(VIEWER_CLOSE.unauthorized, 'stale ticket');
          return;
        }
        applyLease(row.lease_controller, row.lease_epoch);
        await db.botComputers.heartbeatViewer(userId);
        // Nothing below awaits; a socket gone during the awaits above stops here.
        if (closed) return;
        adoptLeaseListener(
          onLeaseChange((changedUser, lease) => {
            if (changedUser === userId) applyLease(lease.controller, lease.epoch);
          }),
        );
        const tunnel = host.openTunnel(row.container_name, 'vnc');
        if (!adoptChild(tunnel)) return;
        pumpTunnel(tunnel, socket);
        writeToServer(pending.splice(0));
        pendingBytes = 0;
      } catch (err) {
        const code = err instanceof ComputerUnavailableError ? err.code : 'unavailable';
        if (!(err instanceof ComputerUnavailableError)) {
          logger.warn(`[bots-computer] viewer could not open: ${toErrorMessage(err)}`);
        }
        viewer.close(VIEWER_CLOSE.unavailable, code);
        return;
      }
      if (closed) return;

      trackTimer(
        setInterval(() => {
          if (!alive) {
            // terminate(), not close(): a half-open peer never answers the
            // close frame, and close() would wait 30 s for it.
            logger.info('[bots-computer] viewer missed a pong; dropping it', { user_id: userId });
            try {
              raw?.terminate();
            } catch {
              /* already gone */
            }
            cleanup();
            return;
          }
          alive = false;
          try {
            raw?.ping();
          } catch {
            /* closing */
          }
        }, PING_MS),
      );
      trackTimer(
        setInterval(() => {
          void db.botComputers.heartbeatViewer(userId).catch(() => {});
        }, HEARTBEAT_MS),
      );
      trackTimer(
        setInterval(() => {
          void refreshLease().catch(() => {});
        }, LEASE_POLL_MS),
      );
      trackTimer(
        setInterval(() => {
          void memberStillAllowed(userId, claims.av)
            .then((result) => {
              if (result !== 'ok') viewer.close(VIEWER_CLOSE.unauthorized, result);
            })
            .catch(() => {});
        }, REVALIDATE_MS),
      );
    },

    onMessage(evt: MessageEvent) {
      if (closed) return;
      alive = true;
      // RFB is binary; a text frame is not a viewer.
      if (typeof evt.data === 'string') {
        viewer.close(VIEWER_CLOSE.protocol, 'binary frames only');
        return;
      }
      const result = filter.push(new Uint8Array(evt.data as ArrayBuffer));
      if (!child) {
        pendingBytes += result.forward.reduce((sum, b) => sum + b.length, 0);
        if (pendingBytes > MAX_PENDING_BYTES) {
          viewer.close(VIEWER_CLOSE.protocol, 'too much data before the computer was ready');
          return;
        }
        pending.push(...result.forward);
      } else {
        writeToServer(result.forward);
      }
      if (result.close) viewer.close(VIEWER_CLOSE.protocol, result.close);
    },

    onClose() {
      cleanup();
    },

    onError() {
      cleanup();
    },
  };
}

computerLifecycleHooks.onPurged((userId) => {
  closeViewersFor(userId, 'computer removed');
});
computerLifecycleHooks.onShutdown(async () => {
  for (const userId of [...viewers.keys()]) closeViewersFor(userId, 'server restarting');
});
