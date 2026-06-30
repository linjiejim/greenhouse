/**
 * Context Provider Registry — 注册和查询页面上下文提供者
 */

import type { PageContextType, ContextProviderDescriptor } from '@greenhouse/types/agent-context';

const registry = new Map<PageContextType, ContextProviderDescriptor<any>>();

export function registerContextProvider<T extends PageContextType>(provider: ContextProviderDescriptor<T>): void {
  registry.set(provider.type, provider);
}

export function getContextProvider<T extends PageContextType>(type: T): ContextProviderDescriptor<T> | undefined {
  return registry.get(type) as ContextProviderDescriptor<T> | undefined;
}

export function getAllProviderTypes(): PageContextType[] {
  return [...registry.keys()];
}
