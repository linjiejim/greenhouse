import { useExtensionsStore } from '../stores/extensions-store';
/**
 * Browser-local invalidation for records shown outside the page that owns them.
 *
 * The side pane's whole promise is "edit it by talking, watch it update on the
 * right". Nothing else delivers that: the pane fetched the record once, and a
 * `project_mutation` that changed it happened entirely on the server.
 *
 * So the chat stream announces which domains a turn wrote to, and anything
 * displaying a record from one of them re-reads. A window Event rather than a
 * store subscription, so the global stream manager stays decoupled from every
 * feature that might be listening.
 *
 * Deliberately coarse: the event names a DOMAIN, not a record id. Mutation
 * tools do not report which row they touched, and inventing an id here would be
 * a guess that silently fails to refresh exactly when it matters.
 */

export const ENTITY_CHANGED_EVENT = 'greenhouse:entity-changed';

/** Domains a chat turn can write to and a pane can be showing. */
export type EntityDomain = string;

/** Mutation tools whose success means "something on screen may be stale". */
const owners = new Map<string, string>();
const TOOL_DOMAINS: Record<string, EntityDomain> = {
  knowledge_mutation: 'knowledge',
};

export function entityDomainForTool(toolName: string): EntityDomain | null {
  const owner = owners.get(toolName);
  if (owner && !useExtensionsStore.getState().extensions.some((ext) => ext.id === owner)) return null;
  return TOOL_DOMAINS[toolName] ?? null;
}

export function notifyEntityChanged(domain: EntityDomain): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ENTITY_CHANGED_EVENT, { detail: domain }));
}

export function onEntityChanged(listener: (domain: EntityDomain) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => listener((event as CustomEvent<EntityDomain>).detail);
  window.addEventListener(ENTITY_CHANGED_EVENT, handler);
  return () => window.removeEventListener(ENTITY_CHANGED_EVENT, handler);
}

export function registerEntitySync(entries: Record<string, string>, owner?: string): void {
  Object.assign(TOOL_DOMAINS, entries);
  if (owner) for (const tool of Object.keys(entries)) owners.set(tool, owner);
}
