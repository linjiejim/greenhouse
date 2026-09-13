/**
 * User Prompts API — quick prompts (slash commands).
 */

import type { PromptScope, UserPrompt } from '@greenhouse/types/api';
import type { TaskVariable } from '@greenhouse/types/tasks';
import { rpc } from './client';

export async function fetchPrompts(scope?: PromptScope): Promise<UserPrompt[]> {
  try {
    const res = await rpc.api.prompts.$get(scope ? { query: { scope } } : undefined);
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
  description?: string;
  variables?: TaskVariable[];
  expected_tools?: string[];
  source_session_id?: string;
  created_via?: 'manual' | 'capture';
  artifact_action_id?: string;
  artifact_session_id?: string;
}): Promise<UserPrompt> {
  // Non-literal arg: the route has no validator, so hc cannot type `json`
  // inline (see ./client.ts) — the indirection keeps response typing.
  const args = { json: input };
  const res = await rpc.api.prompts.$post(args);
  if (!res.ok) throw new Error(`Failed to create prompt: ${res.status}`);
  return res.json();
}

export async function updatePrompt(
  id: number,
  input: {
    title?: string;
    content?: string;
    shortcut?: string | null;
    sort_order?: number;
    is_global?: boolean;
    description?: string | null;
    variables?: TaskVariable[];
    expected_tools?: string[];
  },
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
