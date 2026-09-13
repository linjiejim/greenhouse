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

import {
  MessageSquareWarning,
  Mail,
  Users,
  ClipboardList,
  Key,
  Sprout,
  Package,
  Palette,
  SlidersHorizontal,
  BarChart3,
  FlaskConical,
  Cloud,
  Brain,
  Zap,
  Bot,
  Table2,
  FolderKanban,
  BookOpen,
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
  /** Optional per-user feature flag gate. */
  requireFeature?: FeatureKey;
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
    id: 'settings.groups',
    label: 'Groups',
    icon: Users,
    path: '#/settings/groups',
    parent: 'settings',
    description: 'Groups for knowledge sharing',
  },
  {
    id: 'settings.agent-connections',
    label: 'Agent Connections',
    icon: Key,
    path: '#/settings/agent-connections',
    parent: 'settings',
    description: 'Review and revoke OAuth access granted to external Agents',
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

export const settingsSections: SettingsNavSection[] = [
  { key: 'top', items: SETTINGS_TOP },
  { key: 'labs', label: 'Labs', labelKey: 'navigation.labs', items: SETTINGS_LABS },
];

/** Flat list of every settings module across all sections. */
const SETTINGS_ALL: NavModule[] = settingsSections.flatMap((section) => section.items);

// ─── Administration Modules (super only, global) ─────────
//
// Global management surface, separate from personal Settings. Reachable only by
// super users via the sidebar account flyout → Administration. Every module is
// role-gated; the parent route (#/administration) is itself super-only.

const ADMINISTRATION_MODULES: NavModule[] = [
  {
    id: 'admin.users',
    label: 'Users',
    icon: Users,
    path: '#/administration/users',
    parent: 'administration',
    description: 'Manage users, permissions, features, and limits',
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
    id: 'admin.branding',
    label: 'Branding Studio',
    icon: Palette,
    path: '#/administration/branding',
    parent: 'administration',
    description: 'Workspace branding — product name, logo and theme tokens',
    requireRole: ['super'],
  },
  {
    id: 'admin.usage',
    label: 'Agent Usages',
    icon: BarChart3,
    path: '#/administration/usage',
    parent: 'administration',
    description: 'Token consumption and cost tracking',
    requireRole: ['super'],
  },
  {
    id: 'admin.feature-requests',
    label: 'Feature Requests',
    icon: ClipboardList,
    path: '#/administration/feature-requests',
    parent: 'administration',
    description: 'User-submitted requests',
    requireRole: ['super'],
  },
  {
    id: 'admin.frictions',
    label: 'Frictions',
    icon: MessageSquareWarning,
    path: '#/administration/frictions',
    parent: 'administration',
    description: 'Where the agent stumbled — tool errors and detours to fix',
    requireRole: ['super'],
  },
  {
    id: 'admin.eval',
    label: 'Evaluation',
    icon: FlaskConical,
    path: '#/administration/eval',
    parent: 'administration',
    description: 'Evaluation and testing',
    requireRole: ['super'],
  },
  {
    id: 'admin.llm-gateway',
    label: 'AI Gateway',
    icon: Cloud,
    path: '#/administration/llm-gateway',
    parent: 'administration',
    description: 'Team model gateway — upstreams, models, and keys',
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
];

export const administrationModules = ADMINISTRATION_MODULES;

// ─── Knowledge list modules ─────────────────────────────
//
// Only the three collection views use ModulePage. Document reading/editing,
// folders and sync runs are contextual workspaces with their own detail shell.
const KNOWLEDGE_MODULES: NavModule[] = [
  {
    id: 'knowledge.wiki',
    label: 'Wiki Docs',
    icon: BookOpen,
    path: '#/knowledge/wiki',
    parent: 'knowledge',
    description: 'Synchronized public knowledge base',
    pinnable: false,
  },
  {
    id: 'knowledge.api-sources',
    label: 'API Sources',
    icon: Cloud,
    path: '#/knowledge/api-sources',
    parent: 'knowledge',
    description: 'API content sources',
    pinnable: false,
  },
  {
    id: 'knowledge.expert',
    label: 'Expert Knowledge',
    icon: Sprout,
    path: '#/knowledge/expert',
    parent: 'knowledge',
    description: 'Expert topic knowledge base',
    pinnable: false,
  },
];

// ─── Standalone workspace pages ─────────────────────────
//
// These routes live in the primary application shell rather than a contextual
// Settings/Administration navigation panel. Registering their page identity
// here lets them share ModulePage without creating a second header registry.
const STANDALONE_MODULES: NavModule[] = [
  {
    id: 'workspace.tasks',
    label: 'Tasks',
    icon: ClipboardList,
    path: '#/tasks',
    parent: 'standalone',
    description: 'Reusable instructions available from the Chat composer',
    pinnable: false,
  },
  {
    id: 'workspace.automations',
    label: 'Automation',
    icon: Zap,
    path: '#/automations',
    parent: 'standalone',
    description: 'Schedule recurring work for Agents',
    pinnable: false,
  },
  {
    id: 'workspace.agents',
    label: 'My Agents',
    icon: Bot,
    path: '#/agents',
    parent: 'standalone',
    description: 'Create and manage reusable Agent configurations',
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
    id: 'workspace.projects',
    label: 'Projects',
    icon: FolderKanban,
    path: '#/projects',
    parent: 'standalone',
    description: 'Active, planned, and paused projects in one portfolio view',
    pinnable: false,
  },
  {
    id: 'workspace.executions',
    label: 'Execution Center',
    icon: ClipboardList,
    path: '#/executions',
    parent: 'standalone',
    description: 'Background work, decisions, progress, and outcomes in one place',
    pinnable: false,
  },
  {
    id: 'workspace.skillhub',
    label: 'SkillHub',
    icon: Package,
    path: '#/skillhub',
    parent: 'standalone',
    description: 'The organization-wide library of reusable Agent skills',
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
  'settings.groups': { label: 'navigation.groups', description: 'navigation.groupsDesc' },
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
  'admin.users': { label: 'navigation.users', description: 'navigation.usersDesc' },
  'admin.runtime-config': { label: 'navigation.runtimeConfig', description: 'navigation.runtimeConfigDesc' },
  'admin.branding': { label: 'navigation.branding', description: 'navigation.brandingDesc' },
  'admin.usage': { label: 'navigation.agentUsages', description: 'navigation.agentUsagesDesc' },
  'admin.feature-requests': {
    label: 'navigation.featureRequests',
    description: 'navigation.featureRequestsDesc',
  },
  'admin.frictions': { label: 'navigation.frictions', description: 'navigation.frictionsDesc' },
  'admin.eval': { label: 'navigation.evaluation', description: 'navigation.evaluationDesc' },
  'admin.llm-gateway': { label: 'navigation.aiGateway', description: 'navigation.aiGatewayDesc' },
  'admin.mcp-keys': { label: 'navigation.mcpAccess', description: 'navigation.mcpAccessDesc' },
  'workspace.tasks': { label: 'navigation.myPrompts', description: 'navigation.tasksDesc' },
  'workspace.automations': { label: 'navigation.automation', description: 'navigation.automationDesc' },
  'workspace.agents': { label: 'navigation.myAgents', description: 'navigation.myAgentsDesc' },
  'workspace.tables': { label: 'navigation.tables', description: 'navigation.tablesDesc' },
  'workspace.projects': { label: 'projects.title', description: 'navigation.projectsDesc' },
  'workspace.executions': { label: 'taskCenter.title', description: 'taskCenter.description' },
  'workspace.skillhub': { label: 'skillHub.title', description: 'navigation.skillHubDesc' },
  'knowledge.wiki': { label: 'navigation.wikiDocs', description: 'navigation.wikiDocsDesc' },
  'knowledge.api-sources': { label: 'navigation.apiSources', description: 'navigation.apiSourcesDesc' },
  'knowledge.expert': { label: 'navigation.expertKnowledge', description: 'navigation.expertKnowledgeDesc' },
};

const englishT: Translate = (key, params) => translate('en', key, params);

export function localizeNavModule(module: NavModule, t: Translate): NavModule {
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

  const primary = routeLabels[route];
  if (!primary) return null;

  // Knowledge sub-routes (not in module registry)
  if (route === 'knowledge') {
    const segments = subPath.split('/').filter(Boolean);
    const KNOWLEDGE_SUBS: Record<string, { label: string; description: string }> = {
      wiki: { label: t('navigation.wikiDocs'), description: t('navigation.wikiDocsDesc') },
      'api-sources': { label: t('navigation.apiSources'), description: t('navigation.apiSourcesDesc') },
      expert: { label: t('navigation.expertKnowledge'), description: t('navigation.expertKnowledgeDesc') },
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

  // Handle partial paths (e.g. settings/groups/123 → match settings.groups)
  const segments = subPath.split('/').filter(Boolean);

  // Try matching parent path (strip trailing segments)
  for (let i = segments.length; i >= 1; i--) {
    const tryPath = `#/${route}/${segments.slice(0, i).join('/')}`;
    const match = ALL_MODULES.find((m) => m.path === tryPath);
    if (match) {
      const localized = localizeNavModule(match, t);
      // For detail pages (e.g. settings/groups/123), append the detail ID
      if (i < segments.length && segments[i]) {
        return { primary, secondary: `${localized.label} › #${segments[i]}` };
      }
      return { primary, secondary: localized.label, description: localized.description };
    }
  }

  return null;
}

// ─── Structured exports for sidebar panels ───────────────

export const settingsAllModules = SETTINGS_ALL;
