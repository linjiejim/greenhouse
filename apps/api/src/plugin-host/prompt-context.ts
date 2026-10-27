import { getDb } from '@greenhouse/db';
import { delegatedAgentActor } from './actor.js';
import { hasAgentPromptFragments, resolveAgentPromptFragments } from './agent-context.js';
import type { ExtensionPromptContext } from './define.js';
const entries: ExtensionPromptContext[] = [];
export function registerPromptContexts(contexts: ExtensionPromptContext[]): void {
  entries.push(...contexts);
}
/** Stable context is read only for tools actually installed in this turn. */
export async function resolveExtensionPromptContext(
  userId: string,
  role?: string,
  toolIds?: readonly string[],
): Promise<string | null> {
  const allowed = toolIds && new Set(toolIds);
  const blocks: string[] = [];
  for (const entry of entries) {
    if (allowed && !entry.toolIds.some((id) => allowed.has(id))) continue;
    const block = await entry.build(userId, role);
    if (block) blocks.push(block);
  }
  if (toolIds?.length && hasAgentPromptFragments(toolIds)) {
    const fragment = await resolveAgentPromptFragments({
      db: getDb(),
      userId,
      role: role ?? 'team',
      reachable: new Set(toolIds),
      actor: delegatedAgentActor({ userId }),
    });
    if (fragment) blocks.push(fragment);
  }
  return blocks.length ? blocks.join('\n') : null;
}
