/**
 * Team activity (`GET /api/activity/recent`, apps/api/src/routes/activity.ts): the last 14 days of
 * changes across the team that I may read, newest first, paged with `before` = the previous page's opaque `next_before`.
 * My own log (`GET /api/activity`, a member's rows only) pages by `cursor`; its CSV is src/activity/export.ts.
 * Answers an `ApiResult` (./client.ts), never throws.
 */

import type { MyActivityPage } from '../data/my-activity';
import type { RecentChangesPage } from '../shared/greenhouse-types';
import { get } from './client';

export const ACTIVITY_PAGE_SIZE = 30;

export const listRecentChanges = (query: { before?: string | null; limit?: number } = {}) =>
  get<RecentChangesPage>('/api/activity/recent', {
    limit: query.limit ?? ACTIVITY_PAGE_SIZE,
    before: query.before ?? undefined,
  });

export const listMyActivity = (query: { source?: string; from: string }, cursor?: string | null) =>
  get<MyActivityPage>('/api/activity', { ...query, cursor: cursor ?? undefined, limit: ACTIVITY_PAGE_SIZE });
