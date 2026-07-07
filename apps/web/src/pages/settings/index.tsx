/**
 * Settings page — routes the active settings sub-module to its panel.
 *
 * Sections (see `settingsSections` in nav-registry):
 * - Preferences (standalone, top)
 * - Personal: Automation, My Prompts, My Agents
 * - Workspace: Groups, Cloud Email, Skill Center
 * - Administration (super only): Users, AI Gateway, MCP Access, System Agents, Agent Usages, Feature Requests
 * - Labs (super only, beta): Memory, Branding Studio
 */

import React from 'react';
import { ModulePageShell } from '../../components/app/module-page-shell';
import { useAuthStore } from '../../stores';
import { settingsAllModules } from '../../lib/nav-registry';
import type { NavModule } from '../../lib/nav-registry';

// Sub-panels
import { ProfilesPanel } from './profiles';
import { UsagePanelWithUsers } from './usage-enhanced';
import { FeatureRequestsPanel } from './feature-requests';
import { UserManagementPanel } from './users';
import { PreferencesPanel } from './preferences';
import { AutomationsPanel } from './automations';
import { PromptsPage } from './prompts';
import { MyProfilesPage } from './my-profiles';
import { EmailAccountsPanel } from './email-accounts';
import { MemoryPanel } from './memory';
import { GroupsPanel } from './groups';
import { SkillCenterPanel } from './skills';
import { LlmGatewayAdminPanel } from './admin-llm-gateway';
import { McpKeysPanel } from './mcp-keys';
import { BrandingStudioPanel } from './branding-studio';
import { CrudExamplePage } from './crud-example';
import { findSettingsPanel } from './panels.extensions';

// ─── Sub-module helpers ─────────────────────────────────

const ALL_MODULES = settingsAllModules;
const DEFAULT_MODULE = 'preferences';

function getModuleKey(mod: NavModule) {
  return mod.id.split('.').pop()!;
}

// ─── Main Component ──────────────────────────────────────

export function SettingsPage({ subPath }: { subPath: string }) {
  const { currentUser } = useAuthStore();
  const isSuper = currentUser?.role === 'super';

  // Parse activeModule from subPath (e.g. "users/123" -> "users", detail="123")
  const segments = subPath.split('/').filter(Boolean);
  const moduleKey = segments[0] || DEFAULT_MODULE;

  // Redirect legacy wiki/sync settings URLs to the internal knowledge base.
  if (moduleKey === 'wiki' || moduleKey === 'sync') {
    window.location.hash = '#/knowledge/internal';
    return null;
  }
  const activeModule = ALL_MODULES.find((m) => getModuleKey(m) === moduleKey) ? moduleKey : DEFAULT_MODULE;

  // Build visible modules based on role.
  const canViewModule = (mod: NavModule) => !mod.requireRole || (mod.requireRole.includes('super') && isSuper);
  const visibleModules = ALL_MODULES.filter(canViewModule);

  // If a user tries to access a hidden module, fall back to preferences.
  const effectiveModule = visibleModules.some((m) => getModuleKey(m) === activeModule) ? activeModule : DEFAULT_MODULE;

  return (
    <ModulePageShell activeKey={effectiveModule} mobileItems={visibleModules} contentClassName="bg-surface-sunken">
      {/* Panels — full-width with scroll */}
      <div className="h-full overflow-y-auto">
        <div className="px-3 md:px-4 py-4">
          {effectiveModule === 'preferences' && <PreferencesPanel />}
          {effectiveModule === 'automations' && <AutomationsPanel />}
          {effectiveModule === 'prompts' && <PromptsPage />}
          {effectiveModule === 'my-profiles' && <MyProfilesPage />}
          {effectiveModule === 'users' && <UserManagementPanel />}
          {effectiveModule === 'profiles' && <ProfilesPanel />}
          {effectiveModule === 'usage' && <UsagePanelWithUsers />}
          {effectiveModule === 'feature-requests' && <FeatureRequestsContent />}
          {effectiveModule === 'llm-gateway' && <LlmGatewayAdminPanel />}
          {effectiveModule === 'mcp-keys' && <McpKeysPanel />}
          {effectiveModule === 'groups' && <GroupsPanel />}
          {effectiveModule === 'skills' && <SkillCenterPanel />}
          {effectiveModule === 'email-accounts' && <EmailAccountsPanel />}
          {effectiveModule === 'memory' && <MemoryPanel />}
          {effectiveModule === 'branding' && <BrandingStudioPanel />}
          {effectiveModule === 'crud-example' && <CrudExamplePage />}
          {/* Private fork panels (empty upstream) — see panels.extensions.tsx. */}
          {findSettingsPanel(effectiveModule)?.render()}
        </div>
      </div>
    </ModulePageShell>
  );
}

// ─── Feature Requests Content ────────────────────────────

function FeatureRequestsContent() {
  // Context auto-detected from URL (#/settings/feature-requests)
  return <FeatureRequestsPanel />;
}
