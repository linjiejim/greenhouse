/**
 * Tools API — tool metadata listing for the current user.
 *
 * Per-user tool assignment (fetchUserTools / setUserTools) is admin-scoped
 * and lives in ./admin, not here.
 */

import type { McpResourceGroup } from '@greenhouse/types/mcp';
import { rpc } from './client';

export interface ToolMeta {
  id: string;
  name: string;
  brief: string;
  category: 'core' | 'team' | 'admin';
  is_global: boolean;
  /** Part of every Agent's native ability — not offered as a choice in the editor. */
  builtin?: boolean;
  icon: string;
  /** `mcp` carries the tool's resource group — see @greenhouse/types/mcp. */
  surface?: {
    proxy?: 'read' | 'write' | 'none';
    mcp?: McpResourceGroup;
    workbench?: boolean;
    unattendedReplaySafe?: boolean;
  };
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
