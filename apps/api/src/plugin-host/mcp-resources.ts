/** Protocol resources contributed by active plugins; each provider owns its ACL and legacy URIs. */
import type { AgentContextCaller } from './agent-context.js';
import type { Resource, ResourceTemplate, TextResourceContents } from '@modelcontextprotocol/sdk/types.js';
import { fromExtensions } from './index.js';
export interface ExtensionMcpResources {
  toolIds: readonly string[];
  list: (caller: AgentContextCaller) => Promise<Resource[]>;
  templates: (caller: AgentContextCaller) => Promise<ResourceTemplate[]>;
  read: (uri: string, caller: AgentContextCaller) => Promise<TextResourceContents | undefined>;
}
function providers(caller: AgentContextCaller) {
  return fromExtensions('mcpResources').filter((source) => source.toolIds.some((id) => caller.reachable.has(id)));
}
export async function listPluginResources(caller: AgentContextCaller) {
  return (await Promise.all(providers(caller).map((source) => source.list(caller)))).flat();
}
export async function listPluginResourceTemplates(caller: AgentContextCaller) {
  return (await Promise.all(providers(caller).map((source) => source.templates(caller)))).flat();
}
export async function readPluginResource(uri: string, caller: AgentContextCaller) {
  for (const source of providers(caller)) {
    const content = await source.read(uri, caller);
    if (content) return content;
  }
  return undefined;
}
