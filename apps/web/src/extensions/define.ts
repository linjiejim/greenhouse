import type { ComponentType } from 'react';
import type { Locale } from '../lib/i18n';

export type ExtensionLabel = Record<Locale, string>;
export interface ExtensionPageProps {
  path: string;
  params: URLSearchParams;
}
export interface WebExtension {
  id: string;
  pages?: readonly { id: string; label: ExtensionLabel; component: ComponentType<ExtensionPageProps> }[];
  settingsSections?: readonly { id: string; label: ExtensionLabel; component: ComponentType }[];
  adminSections?: readonly { id: string; label: ExtensionLabel; component: ComponentType }[];
  entityPanels?: readonly {
    id: string;
    entity: 'doc' | 'agent' | 'record' | 'app' | 'skill' | 'run' | `ext:${string}`;
    label: ExtensionLabel;
    component: ComponentType<{ id: string }>;
  }[];
}

export function defineWebExtension(extension: WebExtension): WebExtension {
  const valid = (id: string) => /^[a-z][a-z0-9-]{0,47}$/.test(id);
  if (!valid(extension.id)) throw new Error('Invalid web extension id');
  for (const surfaces of [
    extension.pages,
    extension.settingsSections,
    extension.adminSections,
    extension.entityPanels,
  ]) {
    if (
      surfaces &&
      (surfaces.some((surface) => !valid(surface.id)) ||
        new Set(surfaces.map((surface) => surface.id)).size !== surfaces.length)
    )
      throw new Error(`Invalid or duplicate web surface: ${extension.id}`);
  }
  for (const panel of extension.entityPanels ?? [])
    if (panel.entity.startsWith('ext:') && !panel.entity.startsWith(`ext:${extension.id}:`))
      throw new Error(`Entity panel must use its own namespace: ${extension.id}`);
  return extension;
}
