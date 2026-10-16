import type { Hono } from 'hono';
import type { AnyAdapter } from '@greenhouse/providers';
import type { Services } from '../app.js';
import type { AppEnv } from '../http/env.js';
import type { ToolDef } from '../engine/tools/define.js';

export const EXTENSION_ID = /^[a-z][a-z0-9-]{0,47}$/;
export type PanelEntity = 'agent' | 'doc' | 'record' | 'app' | 'skill' | 'run' | `ext:${string}`;
export interface ExtensionSearchSource {
  id: string;
  search(
    memberId: string,
    query: string,
    limit: number,
  ): Promise<{ id: string; title: string; snippet?: string; path: string }[]>;
}
export interface GreenhouseExtension {
  id: string;
  name: string;
  /** Mounted only at /api/ext/<id>; every route already requires a member. */
  routes?: (services: Services) => Hono<AppEnv>;
  /** Names must start with ext_<id with underscores>_. Existing approval tiers apply. */
  tools?: (services: Services) => readonly ToolDef[];
  searchSources?: (services: Services) => readonly ExtensionSearchSource[];
  providerAdapters?: readonly AnyAdapter[];
  settingsSections?: readonly string[];
  adminSections?: readonly string[];
  entityPanels?: readonly { id: string; entity: PanelEntity }[];
  pages?: readonly string[];
  migrations?: { dir: string };
}

export function defineExtension(extension: GreenhouseExtension): GreenhouseExtension {
  if (!EXTENSION_ID.test(extension.id)) throw new Error('Invalid extension id');
  for (const entries of [
    extension.settingsSections,
    extension.adminSections,
    extension.pages,
    extension.entityPanels?.map((panel) => panel.id),
  ]) {
    if (!entries) continue;
    if (new Set(entries).size !== entries.length || entries.some((id) => !EXTENSION_ID.test(id)))
      throw new Error(`Invalid or duplicate surface in ${extension.id}`);
  }
  for (const adapter of extension.providerAdapters ?? [])
    if (!adapter.kind.startsWith(`${extension.id}-`))
      throw new Error(`Extension adapter must be namespaced: ${extension.id}`);
  for (const panel of extension.entityPanels ?? [])
    if (panel.entity.startsWith('ext:') && !panel.entity.startsWith(`ext:${extension.id}:`))
      throw new Error(`Entity panel must use its own namespace: ${extension.id}`);
  return extension;
}

export function selectExtensions(
  compiled: readonly GreenhouseExtension[],
  enabled: 'all' | readonly string[],
): readonly GreenhouseExtension[] {
  const ids = new Set(compiled.map((extension) => extension.id));
  if (ids.size !== compiled.length) throw new Error('Duplicate extension id');
  if (enabled !== 'all')
    for (const id of enabled) if (!ids.has(id)) throw new Error(`Extension is not compiled: ${id}`);
  return compiled.filter((extension) => enabled === 'all' || enabled.includes(extension.id));
}
