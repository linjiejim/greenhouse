/**
 * Workspace settings API (super only) — registry-driven deployment config.
 *
 * Views come masked from the server: secret values are never returned
 * (has_value/source only). PUT sends a partial { key: value | null } map —
 * null clears the row so the setting falls back to its env var.
 */

import type { WorkspaceSettingView } from '@greenhouse/types';
import { rpc } from './client';

export async function fetchWorkspaceSettings(): Promise<WorkspaceSettingView[]> {
  const res = await rpc.api.admin.settings.$get();
  if (!res.ok) throw new Error(`Failed to load settings: ${res.status}`);
  return ((await res.json()).settings ?? []) as WorkspaceSettingView[];
}

export async function saveWorkspaceSettings(values: Record<string, unknown>): Promise<WorkspaceSettingView[]> {
  // Non-literal arg: hc only types `json` for validator-backed routes; the
  // indirection passes the body while keeping param/response typing.
  const args = { json: { values } };
  const res = await rpc.api.admin.settings.$put(args);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Failed to save settings: ${res.status}`);
  }
  return ((await res.json()).settings ?? []) as WorkspaceSettingView[];
}
