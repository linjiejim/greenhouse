import { authFetch } from '@greenhouse/web/extension-kit';
import { hc } from 'hono/client';
import type routes from '../api/routes.js';
import type { RetroResult } from '@greenhouse/types/hub-context';
export async function generateRetro(month?: string): Promise<RetroResult> {
  const response = await hc<typeof routes>('/api/admin/retro', { fetch: authFetch }).index.$post({
    json: month ? { month } : {},
  });
  if (!response.ok)
    throw new Error(((await response.json()) as { error?: string }).error ?? 'Could not generate retro');
  return (await response.json()) as RetroResult;
}
