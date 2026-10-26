/** Optional domain projections for compact transcripts and citations. Runtime evidence remains exact. */
import type { Reference } from '@greenhouse/types/session';
export interface ToolResultAdapter {
  toolId: string;
  legacyCalls?: Record<
    string,
    Partial<Record<'proxy' | 'dsml', (input: Record<string, unknown>) => Record<string, unknown>>>
  >;
  summarizeInput?: (input: Record<string, unknown>) => unknown;
  summarizeOutput?: (output: Record<string, unknown>) => unknown;
  references?: (output: Record<string, unknown>) => Reference[];
  relevance?: (output: Record<string, unknown>) => Array<{ key: string; value: number }>;
}
let aliases = new Map<
  string,
  { toolId: string; normalize: (input: Record<string, unknown>) => Record<string, unknown> }
>();
let adapters = new Map<string, ToolResultAdapter>();
export function registerToolResultAdapters(entries: ToolResultAdapter[]) {
  const next = new Map<string, ToolResultAdapter>();
  const nextAliases: typeof aliases = new Map();
  for (const entry of entries) {
    if (next.has(entry.toolId)) throw new Error(`Duplicate tool result adapter "${entry.toolId}"`);
    next.set(entry.toolId, entry);
    for (const [name, handlers] of Object.entries(entry.legacyCalls ?? {}))
      for (const transport of ['proxy', 'dsml'] as const) {
        const normalize = handlers[transport];
        if (!normalize) continue;
        const key = `${transport}:${name}`;
        if (nextAliases.has(key)) throw new Error(`Duplicate legacy tool call ${name}`);
        nextAliases.set(key, { toolId: entry.toolId, normalize });
      }
  }
  adapters = next;
  aliases = nextAliases;
}
export function toolResultAdapter(id: string) {
  return adapters.get(id);
}
export function summarizeToolInput(id: string, input: Record<string, unknown>): unknown {
  return adapters.get(id)?.summarizeInput?.(input) ?? input;
}
export function toolResultReferences(id: string, output: Record<string, unknown>): Reference[] {
  return output && !output.error ? (adapters.get(id)?.references?.(output) ?? []) : [];
}
export function toolResultRelevance(id: string, output: Record<string, unknown>) {
  return output && !output.error ? (adapters.get(id)?.relevance?.(output) ?? []) : [];
}

export function normalizePluginToolCall(toolId: string, input: unknown, transport: 'proxy' | 'dsml' = 'proxy') {
  const alias = aliases.get(`${transport}:${toolId}`);
  if (!alias) return { toolId, input };
  const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  return { toolId: alias.toolId, input: alias.normalize(args) };
}
