import type { PluginHostStatus } from '@greenhouse/types/plugin-host';
import { rpc } from './client';

export async function fetchPluginStatus(): Promise<PluginHostStatus[]> {
  const response = await rpc.api.admin.plugins.$get();
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return (await response.json()).plugins;
}
