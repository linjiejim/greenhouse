/**
 * Unified navigation module registry.
 *
 * Single source of truth for navigable sub-modules (Knowledge, Settings,
 * Administration) and standalone ModulePage identities. Consumed by: sidebar
 * panels, top-bar breadcrumbs, pinned section, and shared page headers.
 *
 * Primary navigation is still composed once in platform/navigation.ts for
 * desktop/mobile. Standalone entries here provide page identity only; they do
 * not create another primary-navigation source.
 */

import type { WebExtensionModule, WebExtensionPageModule } from '../extensions/define';
import {
  MessageSquareWarning,
  BookOpen,
  Database,
  Mail,
  Users,
  Key,
  Plug,
  Cloud,
  Package,
  Palette,
  SlidersHorizontal,
  BarChart3,
  Brain,
  Coins,
  Gauge,
  Monitor,
  Zap,
  Table2,
  FolderKanban,
  FolderOpen,
  History,
} from './icons';
import type { LucideIcon } from './icons';
import type { FeatureKey } from '@greenhouse/types/features';
import { translate, type TranslationKey } from './i18n';

// ─── Types ───────────────────────────────────────────────

export interface NavModule {
  /** Unique identifier, e.g. 'settings.preferences' */
  id: string;
  /** Display label */
  label: string;
  /** Lucide icon component */
  icon: LucideIcon;
  /** Hash route path, e.g. '#/settings/preferences' */
  path: string;
  /** Parent primary tab */
  parent: 'settings' | 'administration' | 'knowledge' | 'standalone';
  /** TopBar breadcrumb description */
  description?: string;
  /** Role requirement (empty = all roles can see) */
  requireRole?: 'super'[];
  /** Optional per-user feature flag gate (a core FeatureKey or an extension flag). */
  requireFeature?: FeatureKey | (string & {});
  /** Set for modules an extension contributed; the module only shows while that extension is active. */
  extensionId?: string;
  /** Translation keys for extension modules (core modules use NAV_COPY). */
  labelKey?: string;
  descriptionKey?: string;
  /** Whether this item can be pinned (default true) */
  pinnable?: boolean;
  /**
   * Hide from contextual desktop/mobile navigation while keeping the route live.
   * Used when a module's primary entrance is promoted elsewhere.
   */
  hiddenFromNav?: boolean;
}

// ─── Settings Modules (user-scoped) ──────────────────────
//
// Settings holds *personal* configuration — anything a normal user tunes for
// their own account. Global/admin management lives under the separate
// Administration surface (see below).
//
// Nav sections (see `settingsSections`):
//   • Preferences + Cloud (one flat block, no header) — Preferences, Groups,
//     Agent Connections, Connections
//   • Labs (feature-gated) — Memory
//
// Automation, Tasks, and My Agents live in the Chat workspace and are not
// Settings modules.

/** A settings nav section — an optional header + items. */
export interface SettingsNavSection {
  key: string;
  /** Section header label; omit for the standalone top block (Preferences). */
  label?: string;
  labelKey?: TranslationKey;
  /** Role gate for the entire section. */
  requireRole?: 'super'[];
  items: NavModule[];
}

// Preferences + former "Cloud" items now share one flat, header-less region —
// all of it is personal configuration.
const SETTINGS_TOP: NavModule[] = [
  {
    id: 'settings.preferences',
    label: 'Preferences',
    icon: Palette,
    path: '#/settings/preferences',
    parent: 'settings',
    description: 'Theme, language, and personal notes',
  },
  {
    id: 'settings.agent-connections',
    label: 'Agent Connections',
    icon: Key,
    path: '#/settings/agent-connections',
    parent: 'settings',
    description: 'Connect your agents and see what they wrote as you',
  },
  {
    id: 'settings.provider-bindings',
    label: 'Connections',
    icon: Cloud,
    path: '#/settings/provider-bindings',
    parent: 'settings',
    description: 'Connect Feishu, WeCom and other third-party accounts',
  },
  {
    id: 'settings.email-accounts',
    label: 'Email Accounts',
    icon: Mail,
    path: '#/settings/email-accounts',
    parent: 'settings',
    description: 'Bind a mailbox so the agent can read and send your email',
  },
  {
    // `my-usage`, not `usage`: `#/settings/usage` is the legacy link to Administration › Usage.
    id: 'settings.my-usage',
    label: 'Usage',
    icon: Gauge,
    path: '#/settings/my-usage',
    parent: 'settings',
    description: 'What you and your agents spent this month, and your limit',
  },
  {
    id: 'settings.computer',
    label: 'Cloud computer',
    icon: Monitor,
    path: '#/settings/computer',
    parent: 'settings',
    description: 'Your agents’ own cloud computer: status, minutes and start / stop',
  },
];

const SETTINGS_LABS: NavModule[] = [
  {
    id: 'settings.memory',
    label: 'Memory',
    icon: Brain,
    path: '#/settings/memory',
    parent: 'settings',
    description: 'View and manage what the AI remembers about you',
    requireFeature: 'memory',
  },
];

const SETTINGS_EXTENSIONS: NavModule[] = [];

export const settingsSections: SettingsNavSection[] = [
  { key: 'top', items: SETTINGS_TOP },
  { key: 'labs', label: 'Labs', labelKey: 'navigation.labs', items: SETTINGS_LABS },
  { key: 'extensions', label: 'Extensions', labelKey: 'navigation.extensions', items: SETTINGS_EXTENSIONS },
];

/** Flat list of every settings module across all sections. */
const SETTINGS_ALL: NavModule[] = settingsSections.flatMap((section) => section.items);

// ─── Administration Modules (super only, global) ─────────
//
// Global management surface, separate from personal Settings. Reachable only by
// super users via the sidebar account flyout → Administration. Every module is
// role-gated; the parent route (#/administration) is itself super-only.

const ADMINISTRATION_MODULES: NavModule[] = [
  // v1.5 order: people, what they use, what they changed, what they report,
  // then workspace configuration and agent access.
  {
    id: 'admin.users',
    label: 'Users',
    icon: Users,
    path: '#/administration/users',
    parent: 'administration',
    description: 'Accounts, permissions, and limits',
    requireRole: ['super'],
  },
  {
    id: 'admin.usage',
    label: 'Usage',
    icon: BarChart3,
    path: '#/administration/usage',
    parent: 'administration',
    description: 'Token consumption and cost tracking',
    requireRole: ['super'],
  },
  {
    id: 'admin.services',
    label: 'Services & pricing',
    icon: Coins,
    path: '#/administration/services',
    parent: 'administration',
    description: 'Paid services, their prices, this month’s spend and budgets',
    requireRole: ['super'],
  },
  {
    id: 'admin.activity',
    label: 'Activity log',
    icon: History,
    path: '#/administration/activity',
    parent: 'administration',
    description: 'Changes by people, their agents, automations and admins',
    requireRole: ['super'],
  },
  {
    id: 'admin.issues',
    label: 'Issues & requests',
    icon: MessageSquareWarning,
    path: '#/administration/issues',
    parent: 'administration',
    description: 'Feature requests and frictions reported by members and their agents',
    requireRole: ['super'],
  },
  {
    id: 'admin.team-context',
    label: 'Team context',
    icon: BookOpen,
    path: '#/administration/team-context',
    parent: 'administration',
    description: "What members' agents receive: conventions, glossary, and when the monthly retro runs",
    requireRole: ['super'],
  },
  {
    id: 'admin.branding',
    label: 'Branding Studio',
    icon: Palette,
    path: '#/administration/branding',
    parent: 'administration',
    description: 'Workspace branding — product name, logo and theme tokens',
    requireRole: ['super'],
  },
  {
    id: 'admin.runtime-config',
    label: 'Runtime Config',
    icon: SlidersHorizontal,
    path: '#/administration/runtime-config',
    parent: 'administration',
    description: 'LLM / media / search credentials — DB-backed, env fallback',
    requireRole: ['super'],
  },
  {
    id: 'admin.mcp-keys',
    label: 'MCP Access',
    icon: Key,
    path: '#/administration/mcp-keys',
    parent: 'administration',
    description: 'OAuth clients for external agents (MCP server)',
    requireRole: ['super'],
  },
  {
    id: 'admin.connectors',
    label: 'Connectors',
    icon: Plug,
    path: '#/administration/connectors',
    parent: 'administration',
    description: 'Outside services (MCP servers) the team’s agents can use',
    requireRole: ['super'],
  },
];

export const administrationModules = ADMINISTRATION_MODULES;

// ─── Knowledge list modules ─────────────────────────────
//
// The knowledge page owns its own scope views (team / personal / shared) and
// resolves everything else as a document slug, so there is nothing here to
// register today. Kept as the seam for the next collection view that does need
// a ModulePage identity.
const KNOWLEDGE_MODULES: NavModule[] = [];

// ─── Standalone workspace pages ─────────────────────────
//
// These routes live in the primary application shell rather than a contextual
// Settings/Administration navigation panel. Registering their page identity
// here lets them share ModulePage without creating a second header registry.
const STANDALONE_MODULES: NavModule[] = [
  {
    id: 'workspace.files',
    label: 'Files',
    icon: FolderOpen,
    path: '#/files',
    parent: 'standalone',
    description: 'The team’s files and your own — folders, uploads and previews',
    pinnable: false,
  },
  {
    id: 'workspace.automations',
    label: 'Automation',
    icon: Zap,
    path: '#/automations',
    parent: 'standalone',
    description: 'Scheduled work your agents run, and the run profiles they run as',
    pinnable: false,
  },
  {
    id: 'workspace.tables',
    label: 'Tables',
    icon: Table2,
    path: '#/tables',
    parent: 'standalone',
    description: 'Structured internal data shared with your team and Agents',
    pinnable: false,
  },
  {
    id: 'workspace.data-catalog',
    label: 'Data catalog',
    icon: Database,
    path: '#/tables/catalog',
    parent: 'standalone',
    description: 'The data you can read, and how your agent reaches each source',
    pinnable: false,
  },
  {
    id: 'workspace.projects',
    label: 'Projects',
    icon: FolderKanban,
    path: '#/projects',
    parent: 'standalone',
    description: 'Active, planned, and paused projects in one portfolio view',
    pinnable: false,
  },
  {
    id: 'workspace.activity',
    label: 'Activity log',
    icon: History,
    path: '#/activity',
    parent: 'standalone',
    description: 'What you, your agents and your automations changed',
    pinnable: false,
  },
  {
    id: 'workspace.skillhub',
    label: 'SkillHub',
    icon: Package,
    path: '#/skillhub',
    parent: 'standalone',
    description: 'Skills and prompts the team and its agents share',
    pinnable: false,
  },
];

// ─── Full Registry ───────────────────────────────────────

const ALL_MODULES: NavModule[] = [
  ...KNOWLEDGE_MODULES,
  ...SETTINGS_ALL,
  ...ADMINISTRATION_MODULES,
  ...STANDALONE_MODULES,
];

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

const NAV_COPY: Record<string, { label: TranslationKey; description?: TranslationKey }> = {
  'settings.preferences': { label: 'navigation.preferences', description: 'navigation.preferencesDesc' },
  'settings.agent-connections': {
    label: 'navigation.agentConnections',
    description: 'navigation.agentConnectionsDesc',
  },
  'settings.provider-bindings': {
    label: 'navigation.providerBindings',
    description: 'navigation.providerBindingsDesc',
  },
  'settings.email-accounts': {
    label: 'navigation.emailAccounts',
    description: 'navigation.emailAccountsDesc',
  },
  'settings.memory': { label: 'navigation.memory', description: 'navigation.memoryDesc' },
  'settings.my-usage': { label: 'navigation.myUsage', description: 'navigation.myUsageDesc' },
  'settings.computer': { label: 'navigation.computer', description: 'navigation.computerDesc' },
  'admin.users': { label: 'navigation.users', description: 'navigation.usersDesc' },
  'admin.runtime-config': { label: 'navigation.runtimeConfig', description: 'navigation.runtimeConfigDesc' },
  'admin.branding': { label: 'navigation.branding', description: 'navigation.brandingDesc' },
  'admin.usage': { label: 'navigation.agentUsages', description: 'navigation.agentUsagesDesc' },
  'admin.services': { label: 'navigation.servicesPricing', description: 'navigation.servicesPricingDesc' },
  'admin.issues': { label: 'navigation.issues', description: 'navigation.issuesDesc' },
  'admin.activity': { label: 'navigation.activityLog', description: 'navigation.activityLogAdminDesc' },
  'admin.mcp-keys': { label: 'navigation.mcpAccess', description: 'navigation.mcpAccessDesc' },
  'admin.connectors': { label: 'navigation.connectors', description: 'navigation.connectorsDesc' },
  'admin.team-context': { label: 'navigation.teamContext', description: 'navigation.teamContextDesc' },
  'workspace.data-catalog': { label: 'navigation.dataCatalog', description: 'navigation.dataCatalogDesc' },
  'workspace.files': { label: 'navigation.files', description: 'navigation.filesDesc' },
  'workspace.automations': { label: 'navigation.automation', description: 'navigation.automationDesc' },
  'workspace.tables': { label: 'navigation.tables', description: 'navigation.tablesDesc' },
  'workspace.projects': { label: 'projects.title', description: 'navigation.projectsDesc' },
  'workspace.activity': { label: 'navigation.activityLog', description: 'navigation.activityLogDesc' },
  'workspace.skillhub': { label: 'skillHub.title', description: 'navigation.skillHubDesc' },
};

const englishT: Translate = (key, params) => translate('en', key, params);

export function localizeNavModule(module: NavModule, t: Translate): NavModule {
  if (module.labelKey) {
    return {
      ...module,
      label: t(module.labelKey as TranslationKey),
      description: module.descriptionKey ? t(module.descriptionKey as TranslationKey) : module.description,
    };
  }
  const copy = NAV_COPY[module.id];
  if (!copy) return module;
  return {
    ...module,
    label: t(copy.label),
    description: copy.description ? t(copy.description) : module.description,
  };
}

/** Map for O(1) lookup by id */
const MODULE_MAP = new Map<string, NavModule>(ALL_MODULES.map((m) => [m.id, m]));

// ─── Query Functions ─────────────────────────────────────

/** Look up a module by its unique id */
export function getNavModule(id: string): NavModule | undefined {
  return MODULE_MAP.get(id);
}

// ─── Extension modules ───────────────────────────────────

/**
 * Register Settings / Administration modules contributed by a web extension.
 * Called once at load by apps/web/src/extensions/index.ts; the arrays above are
 * mutated in place so every consumer (panels, page switches, pins, breadcrumbs)
 * sees the modules without a code change. `isNavModuleActive` hides them while
 * the extension is not active on the connected API.
 */
export function registerExtensionNavModules(extensionId: string, modules: readonly WebExtensionModule[]): void {
  for (const mod of modules) {
    // Same id shape as core's own modules (`settings.preferences`, `admin.users`),
    // so an extension panel can say `<ModulePage moduleId="admin.<key>">` exactly
    // like a core panel does. The route stays `#/administration/<key>`.
    const id = `${mod.parent === 'administration' ? 'admin' : 'settings'}.${mod.key}`;
    if (MODULE_MAP.has(id))
      throw new Error(`Extension "${extensionId}" registers nav module "${id}" twice or over a core module`);
    const navModule: NavModule = {
      id,
      label: mod.key,
      icon: mod.icon,
      path: `#/${mod.parent}/${mod.key}`,
      parent: mod.parent,
      requireRole: mod.requireRole,
      requireFeature: mod.requireFeature,
      extensionId,
      labelKey: mod.labelKey,
      descriptionKey: mod.descriptionKey,
    };
    if (mod.parent === 'settings') {
      SETTINGS_EXTENSIONS.push(navModule);
      SETTINGS_ALL.push(navModule);
    } else {
      ADMINISTRATION_MODULES.push(navModule);
    }
    ALL_MODULES.push(navModule);
    MODULE_MAP.set(id, navModule);
  }
}

/**
 * Register the sub-modules of an extension *page* (`#/<route>/<key>`).
 *
 * These are `standalone` identities — page header, breadcrumb and module rail —
 * not entries in Settings or Administration. The id is `<extension id>.<key>`,
 * so a CRM extension's companies screen is `crm.companies`, exactly the shape
 * `<ModulePage moduleId="crm.companies">` expects.
 */
const EXTENSION_ROUTE_TITLES = new Map<string, string>();

export function registerExtensionPageModules(
  extensionId: string,
  route: string,
  modules: readonly WebExtensionPageModule[],
  titleKey?: string,
): void {
  // Breadcrumb root for `#/<route>/...` — without it the page's sub-modules
  // would resolve but have nothing to hang off.
  EXTENSION_ROUTE_TITLES.set(route, titleKey ?? `ext.${extensionId}.title`);
  for (const mod of modules) {
    const id = `${extensionId}.${mod.key}`;
    if (MODULE_MAP.has(id))
      throw new Error(`Extension "${extensionId}" registers page module "${id}" twice or over a core module`);
    const navModule: NavModule = {
      id,
      label: mod.key,
      icon: mod.icon,
      path: `#/${route}/${mod.key}`,
      parent: 'standalone',
      requireRole: mod.requireRole,
      requireFeature: mod.requireFeature,
      hiddenFromNav: mod.hiddenFromNav,
      extensionId,
      labelKey: mod.labelKey,
      descriptionKey: mod.descriptionKey,
    };
    ALL_MODULES.push(navModule);
    MODULE_MAP.set(id, navModule);
  }
}

/** The registered page modules of one extension, in declaration order. */
export function extensionPageModules(extensionId: string): NavModule[] {
  return ALL_MODULES.filter((m) => m.extensionId === extensionId && m.parent === 'standalone');
}

/** Core modules are always active; extension modules only while their extension is. */
export function isNavModuleActive(module: NavModule, activeExtensions: ReadonlyArray<{ id: string }>): boolean {
  return !module.extensionId || activeExtensions.some((ext) => ext.id === module.extensionId);
}

/**
 * Resolve sub-module metadata for TopBar breadcrumb display.
 * Compatible with the existing (route, subPath) calling convention.
 */
export function resolveSubModule(
  route: string,
  subPath: string,
  t: Translate = englishT,
): { primary: string; secondary: string; description?: string } | null {
  if (!subPath) return null;

  const routeLabels: Record<string, string> = {
    settings: t('app.settings'),
    administration: t('app.administration'),
    knowledge: t('app.knowledge'),
  };

  const extensionTitle = EXTENSION_ROUTE_TITLES.get(route);
  const primary = routeLabels[route] ?? (extensionTitle ? t(extensionTitle as TranslationKey) : undefined);
  if (!primary) return null;

  // Knowledge sub-routes (not in module registry)
  if (route === 'knowledge') {
    const segments = subPath.split('/').filter(Boolean);
    const KNOWLEDGE_SUBS: Record<string, { label: string; description: string }> = {
      internal: { label: t('navigation.internalKnowledge'), description: t('navigation.internalKnowledgeDesc') },
      personal: { label: t('navigation.personalKnowledge'), description: t('navigation.personalKnowledgeDesc') },
      new: { label: t('navigation.newDocument'), description: t('navigation.newDocumentDesc') },
    };
    const sub = KNOWLEDGE_SUBS[segments[0]];
    if (sub) {
      if (segments.length > 1 && segments[0] === 'internal') {
        return { primary, secondary: `${sub.label} › ${decodeURIComponent(segments[1])}` };
      }
      return { primary, secondary: sub.label, description: sub.description };
    }
    return null;
  }

  // Build the hash path from route + subPath and look up
  const hashPath = `#/${route}/${subPath}`;

  // Direct match
  const direct = ALL_MODULES.find((m) => m.path === hashPath);
  if (direct) {
    const localized = localizeNavModule(direct, t);
    return { primary, secondary: localized.label, description: localized.description };
  }

  // Handle partial paths (e.g. administration/issues/123 → match admin.issues)
  const segments = subPath.split('/').filter(Boolean);

  // Try matching parent path (strip trailing segments)
  for (let i = segments.length; i >= 1; i--) {
    const tryPath = `#/${route}/${segments.slice(0, i).join('/')}`;
    const match = ALL_MODULES.find((m) => m.path === tryPath);
    if (match) {
      const localized = localizeNavModule(match, t);
      // For detail pages (e.g. administration/issues/123), append the detail ID. Other
      // trailing segments are a module's own tabs or deep links, not an identity.
      if (i < segments.length && /^\d+$/.test(segments[i] ?? '')) {
        return { primary, secondary: `${localized.label} › #${segments[i]}` };
      }
      return { primary, secondary: localized.label, description: localized.description };
    }
  }

  return null;
}

// ─── Structured exports for sidebar panels ───────────────

export const settingsAllModules = SETTINGS_ALL;
