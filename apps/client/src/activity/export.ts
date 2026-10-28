/**
 * My activity as CSV (`GET /api/activity/export`, the list's filters, at most 5000 rows, formula-safe
 * on the station): on the phone the file goes to the share sheet; the browser downloads it
 * (./export.web.ts). Resolves to null when it worked, else the reason.
 */

import { api, queryString } from '../api/client';
import type { MyActivityQuery } from '../data/my-activity';
import { shareTextFile } from '../lib/share-file';

export async function exportMyActivity(query: MyActivityQuery): Promise<string | null> {
  try {
    const res = await api(`/api/activity/export${queryString(query)}`);
    if (!res.ok) return `HTTP ${res.status}`;
    const shared = await shareTextFile('activity.csv', await res.text(), 'text/csv');
    return shared ? null : 'share_unavailable';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
