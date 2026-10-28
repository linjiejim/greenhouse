/** My activity as CSV in the browser: an authenticated download saved as activity.csv (./export.ts). */

import { api, queryString } from '../api/client';

export async function exportMyActivity(query: { source?: string; from: string }): Promise<string | null> {
  try {
    const res = await api(`/api/activity/export${queryString(query)}`);
    if (!res.ok) return `HTTP ${res.status}`;
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = 'activity.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
