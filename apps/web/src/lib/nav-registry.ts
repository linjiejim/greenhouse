/**
 * Unified navigation module registry.
 *
 * Single source of truth for all navigable sub-modules (Settings).
 * Consumed by: sidebar panels, top-bar breadcrumbs, pinned section.
 *
 * Primary tabs (Chat, Projects, Knowledge, Settings) are NOT registered here —
 * they're defined inline in AppSidebar / app.tsx since they're static and few.
 */

import { Mail, Users, MessageSquare, ClipboardList, Key, Palette, Zap, BarChart3, Bot, Cloud, Brain } from './icons';
import type { LucideIcon } from './icons';
import { EXTENSION_SETTINGS_SECTIONS } from './nav-registry.extensions';

// ─── Types ───────────────────────────────────────────────

export interface NavModule {
  /** Unique identifier, e.g. 'settings.users' */
  id: string;
  /** Display label */
  label: string;
  /** Lucide icon component */
  icon: LucideIcon;
  /** Hash route path, e.g. '#/settings/users' */
  path: string;
  /** Parent primary tab */
  parent: 'settings';
  /** Optional sub-group within parent */
  group?: 'content' | 'connections';
  /** Group icon — used for collapsible group headers */
  groupIcon?: LucideIcon;
  /** Group label */
  groupLabel?: string;
  /** TopBar breadcrumb description */
  description?: string;
  /** Whether the module is implemented */
  implemented: boolean;
  /** Role requirement (empty = all roles can see) */
  requireRole?: 'super'[];
  /** Whether this item can be pinned (default true) */
  pinnable?: boolean;
}

// ─── Settings Modules ────────────────────────────────────
//
// Organized by ownership/permission boundary (see `settingsSections` below):
//   • Preferences (standalone, top)
//   • Personal — Automation, My Prompts, My Agents (scoped to the current user)
//   • Workspace — Groups, Cloud Email (shared collaboration + connected accounts)
//   • Administration (super) — Users, AI Gateway, MCP Access, System Agents,
//                              Agent Usages, Feature Requests
//   • Labs (super, beta) — Memory
//
// Module ids/paths are kept stable for deep links + pins even where the
// display label or section changed (e.g. settings.profiles → "System Agents",
// settings.email-accounts moved Labs → Workspace).

/** A settings nav section — an optional header + items. */
export interface SettingsNavSection {
  key: string;
  /** Section header label; omit for the standalone top block (Preferences). */
  label?: string;
  /** Role gate for the entire section. */
  requireRole?: 'super'[];
  items: NavModule[];
}

const SETTINGS_TOP: NavModule[] = [
  {
    id: 'settings.preferences',
    label: 'Preferences',
    icon: Palette,
    path: '#/settings/preferences',
    parent: 'settings',
    description: 'Theme, language, and personal notes',
    implemented: true,
  },
];

const SETTINGS_PERSONAL: NavModule[] = [
  {
    id: 'settings.automations',
    label: 'Automation',
    icon: Zap,
    path: '#/settings/automations',
    parent: 'settings',
    description: 'Scheduled agent tasks',
    implemented: true,
  },
  {
    id: 'settings.prompts',
    label: 'My Prompts',
    icon: MessageSquare,
    path: '#/settings/prompts',
    parent: 'settings',
    description: 'Reusable quick prompts',
    implemented: true,
  },
  {
    id: 'settings.my-profiles',
    label: 'My Agents',
    icon: Bot,
    path: '#/settings/my-profiles',
    parent: 'settings',
    description: 'Custom agent profiles',
    implemented: true,
  },
];

const SETTINGS_WORKSPACE: NavModule[] = [
  {
    id: 'settings.groups',
    label: 'Groups',
    icon: Users,
    path: '#/settings/groups',
    parent: 'settings',
    description: 'Groups for knowledge sharing',
    implemented: true,
  },
  {
    id: 'settings.email-accounts',
    label: 'Cloud Email',
    icon: Mail,
    path: '#/settings/email-accounts',
    parent: 'settings',
    description: 'Connected IMAP/SMTP email accounts',
    implemented: true,
  },
];

const SETTINGS_ADMIN: NavModule[] = [
  {
    id: 'settings.users',
    label: 'Users',
    icon: Users,
    path: '#/settings/users',
    parent: 'settings',
    description: 'Manage users and permissions',
    implemented: true,
    requireRole: ['super'],
  },
  {
    id: 'settings.llm-gateway',
    label: 'AI Gateway',
    icon: Cloud,
    path: '#/settings/llm-gateway',
    parent: 'settings',
    description: 'Team model gateway — upstreams, models, and keys',
    implemented: true,
    requireRole: ['super'],
  },
  {
    id: 'settings.mcp-keys',
    label: 'MCP Access',
    icon: Key,
    path: '#/settings/mcp-keys',
    parent: 'settings',
    description: 'API keys for external agents (MCP server)',
    implemented: true,
    requireRole: ['super'],
  },
  {
    id: 'settings.profiles',
    label: 'System Agents',
    icon: Bot,
    path: '#/settings/profiles',
    parent: 'settings',
    description: 'View and manage agent configurations',
    implemented: true,
    requireRole: ['super'],
  },
  {
    id: 'settings.usage',
    label: 'Agent Usages',
    icon: BarChart3,
    path: '#/settings/usage',
    parent: 'settings',
    description: 'Token consumption and cost tracking',
    implemented: true,
    requireRole: ['super'],
  },
  {
    id: 'settings.feature-requests',
    label: 'Feature Requests',
    icon: ClipboardList,
    path: '#/settings/feature-requests',
    parent: 'settings',
    description: 'User-submitted requests',
    implemented: true,
    requireRole: ['super'],
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
    implemented: true,
    requireRole: ['super'],
  },
];

export const settingsSections: SettingsNavSection[] = [
  { key: 'top', items: SETTINGS_TOP },
  { key: 'personal', label: 'Personal', items: SETTINGS_PERSONAL },
  { key: 'workspace', label: 'Workspace', items: SETTINGS_WORKSPACE },
  { key: 'administration', label: 'Administration', requireRole: ['super'], items: SETTINGS_ADMIN },
  { key: 'labs', label: 'Labs', requireRole: ['super'], items: SETTINGS_LABS },
  // Private fork sections (empty upstream) — see nav-registry.extensions.ts.
  ...EXTENSION_SETTINGS_SECTIONS,
];

/** Flat list of every settings module across all sections. */
const SETTINGS_ALL: NavModule[] = settingsSections.flatMap((section) => section.items);

// ─── Full Registry ───────────────────────────────────────

const ALL_MODULES: NavModule[] = [...SETTINGS_ALL];

/** Map for O(1) lookup by id */
const MODULE_MAP = new Map<string, NavModule>(ALL_MODULES.map((m) => [m.id, m]));

// ─── Query Functions ─────────────────────────────────────

/** Look up a module by its unique id */
export function getNavModule(id: string): NavModule | undefined {
  return MODULE_MAP.get(id);
}

/** Get all modules belonging to a parent tab, optionally excluding grouped items */
export function getModulesByParent(parent: string, excludeGrouped = false): NavModule[] {
  return ALL_MODULES.filter((m) => m.parent === parent && (!excludeGrouped || !m.group));
}

/** Get modules by parent + group */
export function getModulesByGroup(parent: string, group: string): NavModule[] {
  return ALL_MODULES.filter((m) => m.parent === parent && m.group === group);
}

/** Get all registered modules */
export function getAllModules(): NavModule[] {
  return ALL_MODULES;
}

/**
 * Resolve sub-module metadata for TopBar breadcrumb display.
 * Compatible with the existing (route, subPath) calling convention.
 */
export function resolveSubModule(
  route: string,
  subPath: string,
): { primary: string; secondary: string; description?: string } | null {
  if (!subPath) return null;

  const routeLabels: Record<string, string> = {
    settings: 'Settings',
    knowledge: '知识库',
  };

  const primary = routeLabels[route];
  if (!primary) return null;

  // Knowledge sub-routes (not in module registry)
  if (route === 'knowledge') {
    const segments = subPath.split('/').filter(Boolean);
    const KNOWLEDGE_SUBS: Record<string, { label: string; description: string }> = {
      wiki: { label: 'Wiki 文档', description: '同步的公开知识库' },
      'api-sources': { label: 'API 数据源', description: 'API 内容数据源' },
      expert: { label: '专家知识', description: '专家主题知识库' },
      internal: { label: '内部知识库', description: '团队内部文档' },
      personal: { label: '个人知识库', description: '个人私有文档' },
      new: { label: '新建文档', description: '创建知识文档' },
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
    return { primary, secondary: direct.label, description: direct.description };
  }

  // Handle partial paths (e.g. settings/users/123 → match settings.users)
  const segments = subPath.split('/').filter(Boolean);

  // Try matching parent path (strip trailing segments)
  for (let i = segments.length; i >= 1; i--) {
    const tryPath = `#/${route}/${segments.slice(0, i).join('/')}`;
    const match = ALL_MODULES.find((m) => m.path === tryPath);
    if (match) {
      // For detail pages (e.g. dashboard/users/123), append the detail ID
      if (i < segments.length && segments[i]) {
        return { primary, secondary: `${match.label} › #${segments[i]}` };
      }
      return { primary, secondary: match.label, description: match.description };
    }
  }

  return null;
}

// ─── Structured exports for sidebar panels ───────────────

export const settingsAllModules = SETTINGS_ALL;
