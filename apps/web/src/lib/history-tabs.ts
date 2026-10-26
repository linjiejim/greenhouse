/**
 * The Chat sidebar's history tabs and the list request each one makes.
 *
 * `Mine` is my conversations WITHOUT automation runs; `Scheduled` is exactly
 * those runs (`channel='task'`). Both are filtered on the server
 * (`GET /api/sessions?exclude_channel=` / `?channel=`), never in the browser:
 * the sidebar fetches one 500-row window, so a client-side split would let a
 * busy automation crowd real conversations out of it.
 */

import type { SessionScope } from '@greenhouse/types/api';

export type HistoryTab = SessionScope | 'scheduled';

/** The conversation channel automation runs are filed under. */
export const AUTOMATION_RUN_CHANNEL = 'task';

export interface HistoryListRequest {
  scope: SessionScope;
  channel?: string;
  excludeChannels?: readonly string[];
}

export function historyListRequest(tab: HistoryTab): HistoryListRequest {
  if (tab === 'scheduled') return { scope: 'mine', channel: AUTOMATION_RUN_CHANNEL };
  if (tab === 'mine') return { scope: 'mine', excludeChannels: [AUTOMATION_RUN_CHANNEL] };
  return { scope: tab };
}
