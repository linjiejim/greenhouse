/**
 * Tables realtime: tell open clients which records changed, after the commit.
 *
 * Ids only (`tables:records_changed`) — clients refetch through the governed
 * routes, so the event can never carry more than its recipient may read. Sent to
 * online users whose effective level on the Base is not `none`
 * (`resolveBaseAccessForUsers`, the same resolver every handler uses), and to
 * online members of a live app's audience whose role there has a rule for the
 * table (`appAudienceForTable`, Phase 1) — they refetch through the app gateway.
 *
 * Never fails the write it reports: errors are logged and swallowed.
 */

import type { TableBaseRow, UserRow } from '@greenhouse/db';
import type { ServerWsEvent } from '@greenhouse/types/ws';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { connectionManager } from '../../ws/connection-manager.js';
import type { PlatformHandlerContext } from '../runtime.js';
import { resolveBaseAccessForUsers } from './access.js';
import { appAudienceForTable } from './app-audience.js';

export async function publishRecordsChanged(
  ctx: Pick<PlatformHandlerContext, 'db'>,
  base: TableBaseRow,
  tableId: number,
  recordIds: readonly number[],
): Promise<void> {
  const ids = [...new Set(recordIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return;
  try {
    const online = connectionManager.getOnlineUsers();
    if (online.length === 0) return;
    const users = (await Promise.all(online.map((entry) => ctx.db.users.getById(entry.userId)))).filter(
      (user): user is UserRow => Boolean(user),
    );
    const access = await resolveBaseAccessForUsers(ctx, users, base);
    const event: ServerWsEvent = { type: 'tables:records_changed', baseId: base.id, tableId, recordIds: ids };
    const outside: string[] = [];
    for (const [userId, level] of access) {
      if (level.level !== 'none') connectionManager.sendToUser(userId, event);
      else outside.push(userId);
    }
    for (const userId of await appAudienceForTable(ctx, base, tableId, outside)) {
      connectionManager.sendToUser(userId, event);
    }
  } catch (error) {
    logger.warn('[Tables] records_changed fan-out failed', { baseId: base.id, tableId, error: toErrorMessage(error) });
  }
}
