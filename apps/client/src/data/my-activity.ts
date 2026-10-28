/**
 * My activity log (「我」 → 我的动态), pure (./my-activity.test.ts): the filters as the query
 * `GET /api/activity` and its CSV export take, and how a next page joins the list. The station
 * scopes a member's log to their own rows (it ignores `user_id` for members); the client never
 * asks for anyone else's.
 */

import type { ActivityItem } from '../shared/greenhouse-types';

/** Who did it: me, my agents (MCP writes) or my automations; administrator rows are super-only. */
export const MY_ACTIVITY_SOURCES = ['all', 'person', 'agent', 'automation'] as const;
export type MyActivitySource = (typeof MY_ACTIVITY_SOURCES)[number];

/** Days back from now; the station's window is at most 366 days. */
export const MY_ACTIVITY_PERIODS = [7, 30, 90, 365] as const;
export type MyActivityPeriod = (typeof MY_ACTIVITY_PERIODS)[number];

export interface MyActivityFilter {
  source: MyActivitySource;
  days: MyActivityPeriod;
}

export const DEFAULT_MY_ACTIVITY: MyActivityFilter = { source: 'all', days: 30 };

/** A row of the log; the log also carries the run's status (packages/types/src/activity.ts). */
export type MyActivityItem = ActivityItem & { status?: string | null };

export interface MyActivityPage {
  items: MyActivityItem[];
  next_cursor: string | null;
}

/** The query for the list and the export alike (the same filters give the same rows). */
export function myActivityQuery(filter: MyActivityFilter, now: number): { source?: string; from: string } {
  return {
    ...(filter.source === 'all' ? {} : { source: filter.source }),
    from: new Date(now - filter.days * 86_400_000).toISOString(),
  };
}

/** A first page replaces the list; a later one appends only rows not already shown. */
export function joinActivityPage(
  list: readonly MyActivityItem[],
  page: MyActivityPage,
  more: boolean,
): MyActivityItem[] {
  if (!more) return page.items;
  const known = new Set(list.map((item) => item.id));
  return [...list, ...page.items.filter((item) => !known.has(item.id))];
}
