/**
 * Module usage — page-open reporting and the Administration › Usage module report.
 *
 * Counts only: the server stores (day, module, client) totals, never who looked.
 */

import { APP_CLIENT_HEADER, type ModuleUsageReport, type UsageRangeDays } from '@greenhouse/types/usage';
import { isDesktop } from '../desktop/bridge';
import { rpc } from './client';

/**
 * Count one open of `module` (a `PAGE_MODULE_IDS` entry or `ext.<id>`).
 * Fire-and-forget: a lost count is never surfaced to the user.
 */
export function reportPageOpen(module: string): void {
  const args = { json: { module } };
  const init = isDesktop() ? { headers: { [APP_CLIENT_HEADER]: 'desktop' } } : undefined;
  void rpc.api.usage['page-open'].$post(args, init).catch(() => undefined);
}

export async function fetchModuleUsage(days: UsageRangeDays): Promise<ModuleUsageReport> {
  const res = await rpc.api.admin.usage.modules.$get({ query: { days: String(days) } });
  if (!res.ok) throw new Error(`Failed to fetch module usage: ${res.status}`);
  return res.json();
}
