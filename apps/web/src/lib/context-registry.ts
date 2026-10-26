import { useExtensionsStore } from '../stores/extensions-store';
/**
 * Context Provider Registry — 注册和查询页面上下文提供者
 */

import type { PageContext, PageContextType, ContextProviderDescriptor } from '@greenhouse/types/agent-context';

const owners = new Map<PageContextType, string>();
const registry = new Map<PageContextType, ContextProviderDescriptor<any>>();
/** Providers for extension pages, keyed by extension id (the context type is always 'extension'). */
const extensionRegistry = new Map<string, ContextProviderDescriptor<'extension'>>();

export function registerContextProvider<T extends PageContextType>(
  provider: ContextProviderDescriptor<T>,
  owner?: string,
): void {
  registry.set(provider.type, provider);
  if (owner) owners.set(provider.type, owner);
}

export function registerExtensionContextProvider(
  extensionId: string,
  provider: ContextProviderDescriptor<'extension'>,
): void {
  extensionRegistry.set(extensionId, provider);
}

/** Resolve the provider for a context type; extension pages dispatch on the extension id. */
export function getContextProvider<T extends PageContextType>(
  type: T,
  context?: PageContext | null,
): ContextProviderDescriptor<T> | undefined {
  if (type === 'extension' && context?.type === 'extension') {
    return extensionRegistry.get(context.extension) as ContextProviderDescriptor<T> | undefined;
  }
  const owner = owners.get(type);
  if (owner && !useExtensionsStore.getState().extensions.some((ext) => ext.id === owner)) return undefined;
  return registry.get(type) as ContextProviderDescriptor<T> | undefined;
}
