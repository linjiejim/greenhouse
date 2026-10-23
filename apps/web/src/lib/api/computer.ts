/**
 * Cloud computer — the member's own (`/api/computer`) and the admins' list of
 * running ones (`/api/admin/computers`). The on / off switch is the workspace
 * setting `computer.enabled`, saved through the workspace settings API.
 */

import type { AdminComputersReport, ComputerView, MyComputerReport } from '@greenhouse/types/metering';
import { rpc } from './client';
import { saveWorkspaceSettings } from './workspace-settings';

async function errorOf(res: Response, fallback: string): Promise<Error> {
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(typeof data?.error === 'string' ? data.error : fallback);
}

export async function fetchMyComputer(): Promise<MyComputerReport> {
  const res = await rpc.api.computer.$get();
  if (!res.ok) throw await errorOf(res, `Failed to load your cloud computer: ${res.status}`);
  return (await res.json()) as MyComputerReport;
}

export async function startMyComputer(): Promise<ComputerView> {
  const res = await rpc.api.computer.start.$post();
  if (!res.ok) throw await errorOf(res, `Failed to start the cloud computer: ${res.status}`);
  return ((await res.json()) as { computer: ComputerView }).computer;
}

export async function stopMyComputer(): Promise<void> {
  const res = await rpc.api.computer.stop.$post();
  if (!res.ok) throw await errorOf(res, `Failed to stop the cloud computer: ${res.status}`);
}

export async function fetchAdminComputers(): Promise<AdminComputersReport> {
  const res = await rpc.api.admin.computers.$get();
  if (!res.ok) throw await errorOf(res, `Failed to load the cloud computers: ${res.status}`);
  return (await res.json()) as AdminComputersReport;
}

export async function stopAdminComputer(id: string): Promise<void> {
  const res = await rpc.api.admin.computers[':id'].stop.$post({ param: { id } });
  if (!res.ok) throw await errorOf(res, `Failed to stop the cloud computer: ${res.status}`);
}

/** true / false stores an override; null drops it so the env var / default (off) applies again. */
export async function setComputerEnabled(enabled: boolean | null): Promise<void> {
  await saveWorkspaceSettings({ 'computer.enabled': enabled });
}
