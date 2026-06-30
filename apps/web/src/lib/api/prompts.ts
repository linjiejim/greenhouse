/**
 * User Prompts API — quick prompts (slash commands).
 */

import type { UserPrompt } from '@greenhouse/types/api';
import { rpc } from './client';

export async function fetchPrompts(): Promise<UserPrompt[]> {
  try {
    const res = await rpc.api.prompts.$get();
    if (!res.ok) return [];
    return (await res.json()).prompts ?? [];
  } catch {
    return [];
  }
}

export async function createPrompt(input: {
  title: string;
  content: string;
  shortcut?: string;
  sort_order?: number;
  is_global?: boolean;
}): Promise<UserPrompt> {
  const res = await rpc.api.prompts.$post({ json: input });
  if (!res.ok) throw new Error(`Failed to create prompt: ${res.status}`);
  return res.json();
}

export async function updatePrompt(
  id: number,
  input: { title?: string; content?: string; shortcut?: string | null; sort_order?: number; is_global?: boolean },
): Promise<UserPrompt> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet);
  // the indirection passes the body while keeping param/response typing.
  const args = { param: { id: String(id) }, json: input };
  const res = await rpc.api.prompts[':id'].$patch(args);
  if (!res.ok) throw new Error(`Failed to update prompt: ${res.status}`);
  return res.json();
}

export async function deletePrompt(id: number): Promise<void> {
  const res = await rpc.api.prompts[':id'].$delete({ param: { id: String(id) } });
  if (!res.ok) throw new Error(`Failed to delete prompt: ${res.status}`);
}
