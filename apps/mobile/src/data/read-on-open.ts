/**
 * Opening a notification reads it (app/notification.tsx). React-free (./read-on-open.test.ts):
 * the banner goes only once the server has it read — offline, the row turns back to unread, the
 * member is told, and the banner stays as a reminder. A notification the list does not have yet
 * is fetched by reading it (v1 has no single-notification read).
 */

import type { PlatformNotification } from '../shared/greenhouse-types';

export interface ReadOnOpenDeps {
  /** The notification as the list has it, if it does. */
  known: PlatformNotification | undefined;
  /** Optimistic read of a listed notification; false when the server refused or was unreachable. */
  markRead: (id: string) => Promise<boolean>;
  /** Read one the list does not have; the server answers with it, or null. */
  fetchByReading: (id: string) => Promise<PlatformNotification | null>;
  clearBanner: (id: string) => Promise<void> | void;
  /** A listed notification could not be marked read. */
  reportFailure: () => void;
}

export async function readOnOpen(
  id: string,
  deps: ReadOnOpenDeps,
): Promise<{ notification: PlatformNotification | null; read: boolean }> {
  if (deps.known) {
    if (deps.known.read_at) {
      await deps.clearBanner(id);
      return { notification: deps.known, read: true };
    }
    const read = await deps.markRead(id);
    if (read) await deps.clearBanner(id);
    else deps.reportFailure();
    return { notification: deps.known, read };
  }
  const found = await deps.fetchByReading(id);
  if (found) await deps.clearBanner(id);
  return { notification: found, read: !!found };
}
