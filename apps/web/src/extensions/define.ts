/**
 * The web half of the extension contract — see EXTENDING.md → "Extensions".
 *
 * A web extension lives in `apps/web/src/extensions/<id>/`, exports
 * `defineWebExtension({...})` and is listed once in `apps/web/src/extensions/index.ts`.
 * Every field maps onto an existing registry (routes, navigation, settings /
 * administration modules, translations, tool cards, agent context). The API
 * decides which ids are active (`GET /api/extensions`); inactive extensions
 * render nothing even though they are compiled in.
 */
import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';
import type { EntityRef } from '@greenhouse/types/entity-links';
import type { LucideIcon } from '../lib/icons';
import type { Locale } from '../lib/i18n';
import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';

/** Translation keys an extension owns: `ext.<id>.<name>` (typed loosely on purpose). */
export type ExtensionTranslationKey = `ext.${string}`;

export interface ExtensionPageProps {
  /** Everything after `#/<route>/`. */
  subPath: string;
  params: URLSearchParams;
}

export interface WebExtensionPage {
  /** Top-level hash segment: the page answers `#/<route>` and `#/<route>/...`. */
  route: string;
  component: LazyExoticComponent<ComponentType<ExtensionPageProps>> | ComponentType<ExtensionPageProps>;
  /** Contextual sidebar rail (desktop) / drawer section (mobile) while the page is open. */
  sidebarPanel?: ComponentType<{ subPath: string; onNavigate?: () => void }>;
  /** Top-bar title; defaults to the extension name from the API. */
  titleKey?: ExtensionTranslationKey;
}

export interface WebExtensionNavItem {
  id: string;
  labelKey: ExtensionTranslationKey;
  icon: LucideIcon;
  /** e.g. `#/example` */
  href: string;
  /** The page route this item highlights. */
  route: string;
  /** Hide unless the user has this feature flag (super always passes). */
  requireFeature?: string;
  requireRole?: 'super'[];
}

/** A Settings or Administration module contributed by an extension. */
export interface WebExtensionModule {
  /** Key under the parent, e.g. `crm` → `#/settings/crm`. */
  key: string;
  parent: 'settings' | 'administration';
  labelKey: ExtensionTranslationKey;
  descriptionKey?: ExtensionTranslationKey;
  icon: LucideIcon;
  component: ComponentType;
  requireRole?: 'super'[];
  requireFeature?: string;
}

/** What a tool card receives: the call as the transcript holds it (input may be absent for legacy receipts). */
export interface ExtensionToolCallView {
  name: string;
  input?: unknown;
  output?: unknown;
  status?: 'calling' | 'done';
}

/** The browser half of a record kind the API registered a route for. */
export interface WebExtensionEntityKind {
  /** `ext:<extension id>:<name>` — must match the API-side registration. */
  kind: string;
  icon: LucideIcon;
  /** Header copy while a record has no title of its own. */
  fallbackTitleKey: ExtensionTranslationKey;
  /** Peek / side-pane body; omit when the record has no inline view. */
  render?: (ref: EntityRef) => ReactNode;
}

/** Display copy for an MCP consent group the API half registered. */
export interface WebExtensionMcpGroup {
  id: string;
  labelKey: ExtensionTranslationKey;
  descriptionKey: ExtensionTranslationKey;
}

/** A section appended to every knowledge document while the extension is active. */
export interface WebExtensionKnowledgeDocPanel {
  id: string;
  component: ComponentType<{ docId: number }>;
}

export interface WebExtensionToolCard {
  /** Tool id whose result renders as this card instead of a trace row. */
  tool: string;
  component: ComponentType<{ call: ExtensionToolCallView }>;
  /** `inline` (default) renders above the prose like other artifacts; `below` after it. */
  placement?: 'inline' | 'below';
}

export interface WebExtension {
  id: string;
  pages?: WebExtensionPage[];
  /** Entries for the sidebar "More" menu. */
  navigation?: WebExtensionNavItem[];
  modules?: WebExtensionModule[];
  /** Translations, merged under `ext.<id>` — e.g. `{ en: { title: 'Notes' }, zh: { title: '笔记' } }`. */
  messages?: Partial<Record<Locale, Record<string, unknown>>>;
  toolCards?: WebExtensionToolCard[];
  /** Lucide icons for the extension's tools (trace rows, catalogs). */
  toolIcons?: Record<string, LucideIcon>;
  /** Icons and peek bodies for the record kinds the API half registered. */
  entityKinds?: WebExtensionEntityKind[];
  /** Consent-screen copy for the MCP groups the API half registered. */
  mcpGroups?: WebExtensionMcpGroup[];
  /** Sections appended to every knowledge document. */
  knowledgeDocPanels?: WebExtensionKnowledgeDocPanel[];
  /** Agent-panel context for the extension's pages (label, quick actions, hint). */
  contextProvider?: ContextProviderDescriptor<'extension'>;
  /** Imperative hook run once when the extension is loaded (registering client actions, etc.). */
  onLoad?: () => void;
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function defineWebExtension(extension: WebExtension): WebExtension {
  if (!ID_PATTERN.test(extension.id)) {
    throw new Error(`Web extension id "${extension.id}" must match ${ID_PATTERN}`);
  }
  return extension;
}
