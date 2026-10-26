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
  if (!entries.length) return null;
  const allowed = toolIds && new Set(toolIds);
  const blocks: string[] = [];
  for (const entry of entries) {
    if (allowed && !entry.toolIds.some((id) => allowed.has(id))) continue;
    const block = await entry.build(userId, role);
    if (block) blocks.push(block);
  }
  return blocks.length ? blocks.join('\n') : null;
}
