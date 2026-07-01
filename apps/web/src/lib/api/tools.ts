/**
 * Tools API — tool metadata listing for the current user.
 *
 * Per-user tool assignment (fetchUserTools / setUserTools) is admin-scoped
 * and lives in ./admin, not here.
 */

import { rpc } from './client';

/** Functional domain a tool belongs to — the axis the UI sections by (mirrors the API's ToolGroup). */
export type ToolGroup = 'knowledge' | 'projects' | 'email' | 'sessions' | 'web' | 'media' | 'compute' | 'interaction';

export interface ToolMeta {
  id: string;
  name: string;
  brief: string;
  category: 'public' | 'team' | 'admin' | 'local';
  group: ToolGroup;
  is_global: boolean;
  icon: string;
}

export async function fetchTools(): Promise<ToolMeta[]> {
  try {
    const res = await rpc.api.tools.$get();
    if (!res.ok) return [];
    return (await res.json()).tools ?? [];
  } catch {
    return [];
  }
}
