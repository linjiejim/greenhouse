import type { DatabaseProvider } from '@greenhouse/db';
import type { ActorContext } from '@greenhouse/platform-kernel';
import type { TeamPrompt, TeamPromptDescriptor } from '../hub-context/prompts.js';
let contexts: Array<{ id: string; context: ExtensionAgentContext; toolIds: string[] }> = [];
export function registerAgentContexts(
  entries: Array<{ id: string; context: ExtensionAgentContext; toolIds: string[] }>,
): void {
  contexts = entries;
}

export interface AgentContextCaller {
  db: DatabaseProvider;
  userId: string;
  role: string;
  reachable: ReadonlySet<string>;
  actor: ActorContext;
}

export interface AgentContextResource {
  name: string;
  title: string;
  description: string;
  read: (ctx: AgentContextCaller) => Promise<string> | string;
}

export interface AgentContextPrompt extends Omit<TeamPromptDescriptor, 'description' | 'arguments'> {
  description?: string;
  arguments?: TeamPromptDescriptor['arguments'];
  /** Existing official skill prompt names survive the ownership move. */
  legacyName?: string;
  render: (
    args: Readonly<Record<string, string>>,
    ctx: AgentContextCaller,
  ) => Promise<TeamPrompt | string | null> | TeamPrompt | string | null;
}

export interface ExtensionAgentContext {
  /** Optional narrower reach, still intersected with this plugin's actual tools. */
  toolIds?: readonly string[];
  legacyPromptPrefixes?: readonly string[];
  /** Session-stable instructions; the host enforces a 2000-character ceiling. */
  promptFragment?: (ctx: AgentContextCaller) => Promise<string | null> | string | null;
  resources?: AgentContextResource[];
  /** Dynamic catalogues use list; each returned prompt has the same render contract. */
  prompts?: Array<
    | AgentContextPrompt
    | {
        list: (ctx: AgentContextCaller) => Promise<AgentContextPrompt[]>;
        get?: (
          name: string,
          args: Readonly<Record<string, string>>,
          ctx: AgentContextCaller,
        ) => Promise<TeamPrompt | null>;
      }
  >;
}

function entries(caller: AgentContextCaller) {
  return contexts.filter(({ context, toolIds }) =>
    toolIds.some((id) => caller.reachable.has(id) && (!context.toolIds || context.toolIds.includes(id))),
  );
}
export async function resolveAgentPromptFragments(caller: AgentContextCaller): Promise<string | null> {
  const blocks: string[] = [];
  for (const { context } of entries(caller)) {
    const text = await context.promptFragment?.(caller);
    if (text) blocks.push(text.slice(0, 2000));
  }
  return blocks.length ? blocks.join('\n\n') : null;
}

export function listAgentResources(caller: AgentContextCaller) {
  return entries(caller).flatMap(({ id, context }) =>
    (context.resources ?? []).map(({ name, title, description }) => ({
      uri: `greenhouse://ext/${id}/${name}`,
      name: `ext-${id}-${name}`,
      title,
      description,
      mimeType: 'text/markdown' as const,
    })),
  );
}

export async function readAgentResource(caller: AgentContextCaller, uri: string) {
  for (const { id, context } of entries(caller)) {
    const resource = context.resources?.find((entry) => uri === `greenhouse://ext/${id}/${entry.name}`);
    if (resource) return { uri, mimeType: 'text/markdown' as const, text: await resource.read(caller) };
  }
  return undefined;
}

async function prompts(caller: AgentContextCaller) {
  const out: Array<{ name: string; prompt: AgentContextPrompt }> = [];
  for (const { id, context } of entries(caller)) {
    for (const provider of context.prompts ?? []) {
      for (const prompt of 'list' in provider ? await provider.list(caller) : [provider]) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prompt.name))
          throw new Error(`Invalid agent prompt name "${prompt.name}"`);
        if (prompt.legacyName && !context.legacyPromptPrefixes?.some((prefix) => prompt.legacyName!.startsWith(prefix)))
          throw new Error(`Invalid legacy prompt name "${prompt.legacyName}"`);
        const name = prompt.legacyName ?? `ext-${id}-${prompt.name}`;
        if (out.some((entry) => entry.name === name)) throw new Error(`Duplicate agent prompt "${name}"`);
        out.push({ name, prompt });
      }
    }
  }
  return out;
}

export async function listAgentPrompts(caller: AgentContextCaller): Promise<TeamPromptDescriptor[]> {
  return (await prompts(caller)).map(({ name, prompt }) => ({
    name,
    title: prompt.title,
    description: prompt.description ?? '',
    arguments: prompt.arguments ?? [],
  }));
}

export async function getAgentPrompt(
  caller: AgentContextCaller,
  name: string,
  args: Readonly<Record<string, string>>,
): Promise<TeamPrompt | null> {
  for (const { id, context } of entries(caller)) {
    if (!name.startsWith(`ext-${id}-`) && !context.legacyPromptPrefixes?.some((prefix) => name.startsWith(prefix)))
      continue;
    for (const provider of context.prompts ?? []) {
      if ('list' in provider && provider.get) {
        const value = await provider.get(name, args, caller);
        if (value) return value;
      }
    }
  }
  const entry = (await prompts(caller)).find((entry) => entry.name === name);
  if (!entry) return null;
  const rendered = await entry.prompt.render(args, caller);
  return typeof rendered === 'string'
    ? {
        description: entry.prompt.description ?? '',
        messages: [{ role: 'user', content: { type: 'text', text: rendered } }],
      }
    : rendered;
}

export function hasAgentPromptFragments(toolIds: readonly string[]): boolean {
  return contexts.some(
    (entry) =>
      entry.context.promptFragment &&
      entry.toolIds.some(
        (id) => toolIds.includes(id) && (!entry.context.toolIds || entry.context.toolIds.includes(id)),
      ),
  );
}
