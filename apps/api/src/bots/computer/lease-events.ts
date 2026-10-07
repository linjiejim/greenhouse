/**
 * Lease change notifications inside this process. The take-over routes
 * (lease.ts) publish; live viewers (viewer.ts) subscribe so keyboard and mouse
 * forwarding follows the lease at once (other slots' changes arrive through
 * the viewers' 5 s DB poll). A separate module so the viewer never depends on
 * the conversation engine that lease.ts wakes Bots through.
 */

import type { BotComputerRow } from '@greenhouse/db';

import { connectionManager } from '../../ws/connection-manager.js';
import type { ComputerLease } from './access.js';

type LeaseListener = (userId: string, lease: ComputerLease) => void;
const leaseListeners = new Set<LeaseListener>();

/** Subscribe to lease changes made by this process; returns the unsubscribe. */
export function onLeaseChange(listener: LeaseListener): () => void {
  leaseListeners.add(listener);
  return () => leaseListeners.delete(listener);
}

/** Publish a lease change to local viewers and the owner's open tabs (WS `bots:computer`). */
export function leaseChanged(row: BotComputerRow): void {
  const lease: ComputerLease = { controller: row.lease_controller, epoch: row.lease_epoch };
  for (const listener of leaseListeners) listener(row.user_id, lease);
  connectionManager.sendToUser(row.user_id, {
    type: 'bots:computer',
    state: row.state,
    controller: row.lease_controller,
  });
}
