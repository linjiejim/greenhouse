/**
 * Settings page — routes the active settings sub-module to its panel.
 *
 * Settings is *user-scoped* personal configuration. Global management moved to
 * the separate Administration surface (see pages/administration).
 *
 * Sections (see `settingsSections` in nav-registry):
 * - Preferences + Cloud (one flat block): Preferences, Groups, Agent Connections,
 *   Connections, Email Accounts
 * - Labs (feature-gated): Memory
 *
 * Personal Chat utilities (Automation, Tasks, My Agents) render inside
 * the Chat workspace and are intentionally absent from Settings.
 */

import React from 'react';
import { ModulePageShell } from '../../components/app/module-page-shell';
import { useAuthStore } from '../../stores';
import { settingsAllModules } from '../../lib/nav-registry';
import { canUseFeature } from '../../lib/features';
import type { NavModule } from '../../lib/nav-registry';

// Sub-panels
import { PreferencesPanel } from './preferences';
import { ProviderBindingsPanel } from './provider-bindings';
import { EmailAccountsPanel } from './email-accounts';
import { MemoryPanel } from './memory';
import { GroupsPanel } from './groups';
import { OAuthGrantsPanel } from './oauth-grants';
import { DEFAULT_MODULE, resolveSettingsRedirect } from './redirects';

// ─── Sub-module helpers ─────────────────────────────────

const ALL_MODULES = settingsAllModules;

function getModuleKey(mod: NavModule) {
  return mod.id.split('.').pop()!;
}

// ─── Main Component ──────────────────────────────────────

export function SettingsPage({ subPath }: { subPath: string }) {
  const { currentUser } = useAuthStore();

  // Redirect legacy Settings deep links (admin modules → Administration) to
  // their new homes. See redirects.ts for the map.
  const redirect = resolveSettingsRedirect(subPath);
  if (redirect) {
    window.location.hash = redirect;
    return null;
  }

  // Parse activeModule from subPath (e.g. "eval/runs/123" -> "eval", detail="runs/123")
  const segments = subPath.split('/').filter(Boolean);
  const moduleKey = segments[0] || DEFAULT_MODULE;

  const activeModule = ALL_MODULES.find((m) => getModuleKey(m) === moduleKey) ? moduleKey : DEFAULT_MODULE;

  // Build visible modules based on role + feature gates.
  const canViewModule = (mod: NavModule) => {
    const roleAllowed = !mod.requireRole || (mod.requireRole.includes('super') && currentUser?.role === 'super');
    const featureAllowed = !mod.requireFeature || canUseFeature(currentUser, mod.requireFeature);
    return roleAllowed && featureAllowed;
  };
  const visibleModules = ALL_MODULES.filter(canViewModule);
  const visibleNavigationModules = visibleModules.filter((mod) => !mod.hiddenFromNav);

  // Unknown or unauthorized modules fall back to preferences.
  const effectiveModule = visibleModules.some((m) => getModuleKey(m) === activeModule) ? activeModule : DEFAULT_MODULE;
  return (
    <ModulePageShell
      activeKey={effectiveModule}
      mobileItems={visibleNavigationModules}
      contentClassName="bg-surface-canvas"
    >
      {effectiveModule === 'preferences' && <PreferencesPanel />}
      {effectiveModule === 'agent-connections' && <OAuthGrantsPanel />}
      {effectiveModule === 'provider-bindings' && <ProviderBindingsPanel />}
      {effectiveModule === 'email-accounts' && <EmailAccountsPanel />}
      {effectiveModule === 'groups' && <GroupsPanel />}
      {effectiveModule === 'memory' && <MemoryPanel />}
    </ModulePageShell>
  );
}
