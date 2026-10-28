import { groupFrictions, clip, type DatabaseProvider } from '@greenhouse/api/extension-kit';
import { feedbackServices, type FeedbackServices } from './services.js';
const FRICTION_PAGE = 500;
/** Every friction active in the window, page by page — grouping a slice would undercount. */
export async function allActiveFrictions(
  db: DatabaseProvider,
  window: { from: string; to: string },
  pageSize: number = FRICTION_PAGE,
) {
  const rows: Awaited<ReturnType<FeedbackServices['toolFrictions']['listActiveBetween']>> = [];
  let afterId: string | undefined;
  for (;;) {
    // Keyset on the immutable id: a friction recorded between pages is still read exactly once.
    const page = await feedbackServices(db).toolFrictions.listActiveBetween({ ...window, limit: pageSize, afterId });
    rows.push(...page);
    if (page.length < pageSize) return rows;
    afterId = page[page.length - 1]!.id;
  }
}

export async function feedbackSummary(db: DatabaseProvider, window: { from: string; to: string }) {
  const { toolFrictions, featureRequests } = feedbackServices(db);
  const [rows, counts, requests, statuses] = await Promise.all([
    allActiveFrictions(db, window),
    toolFrictions.countBetween(window),
    featureRequests.listCreatedBetween({ ...window, limit: 10 }),
    featureRequests.countCreatedBetweenByStatus(window),
  ]);
  return {
    frictions: { active: counts.active, new: counts.new, top: groupFrictions(rows).slice(0, 10) },
    requests: {
      submitted: Object.values(statuses).reduce((sum, n) => sum + n, 0),
      by_status: statuses,
      top: requests.map((row) => ({ title: clip(row.title, 120), status: row.status, priority: row.priority })),
    },
  };
}
