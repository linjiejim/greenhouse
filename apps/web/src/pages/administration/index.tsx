/**
 * Administration page — global management surface (super only).
 *
 * Split out from Settings: Settings is user-scoped personal config, while
 * Administration holds org-wide management (Users, Agent Usages,
 * Feature Requests, Evaluation, AI Gateway, MCP Access, Runtime Config, Branding).
 *
 * Routes the active administration sub-module to its panel. The panels
 * themselves are reused verbatim from the old Settings > Administration section.
 */

import { isNavModuleActive } from '../../lib/nav-registry';
import { extensionModuleComponent } from '../../extensions';
import { useExtensionsStore } from '../../stores/extensions-store';
import React from 'react';
import { ModulePageShell } from '../../components/app/module-page-shell';
import { useAuthStore } from '../../stores';
import { administrationModules } from '../../lib/nav-registry';
import type { NavModule } from '../../lib/nav-registry';
import { useT } from '../../lib/i18n';

// Sub-panels (shared with the former Settings > Administration section)
import { UsagePanelWithUsers } from './usage';
import { FeatureRequestsPanel } from './feature-requests';
import { FrictionsPanel } from './frictions';
import { UserManagementPanel } from './users';
import { EvalPage } from '../eval';
import { LlmGatewayAdminPanel } from './llm-gateway';
import { McpKeysPanel } from './mcp-keys';
import { RuntimeConfigPanel } from './runtime-config';
import { BrandingStudioPanel } from './branding-studio';

const ALL_MODULES = administrationModules;
const DEFAULT_MODULE = 'users';

function getModuleKey(mod: NavModule) {
  return mod.id.split('.').pop()!;
}

export function AdministrationPage({ subPath }: { subPath: string }) {
  const t = useT();
  const { currentUser } = useAuthStore();
  const activeExtensions = useExtensionsStore((s) => s.extensions);
  const isSuper = currentUser?.role === 'super';

  const segments = subPath.split('/').filter(Boolean);
  const requestedModuleKey = segments[0] || DEFAULT_MODULE;
  const moduleKey = requestedModuleKey === 'profiles' ? 'usage' : requestedModuleKey;

  // Administration is super-only end to end.
  if (!isSuper) {
    return <div className="flex h-full items-center justify-center text-sm text-fg-faint">{t('app.noPermission')}</div>;
  }

  const visibleModules = ALL_MODULES.filter((m) => isNavModuleActive(m, activeExtensions));
  const activeModule = visibleModules.find((m) => getModuleKey(m) === moduleKey) ? moduleKey : DEFAULT_MODULE;
  const extensionModule = extensionModuleComponent('administration', activeModule);
  return (
    <ModulePageShell activeKey={activeModule} mobileItems={visibleModules} contentClassName="bg-surface-canvas">
      {/* Eval takes full height with its own scroll */}
      {activeModule === 'eval' && <EvalPage subPath={segments.slice(1).join('/')} />}
      {activeModule === 'users' && <UserManagementPanel />}
      {activeModule === 'usage' && <UsagePanelWithUsers />}
      {activeModule === 'feature-requests' && <FeatureRequestsPanel />}
      {activeModule === 'frictions' && <FrictionsPanel />}
      {activeModule === 'llm-gateway' && <LlmGatewayAdminPanel />}
      {activeModule === 'mcp-keys' && <McpKeysPanel />}
      {activeModule === 'runtime-config' && <RuntimeConfigPanel />}
      {activeModule === 'branding' && <BrandingStudioPanel />}
      {extensionModule && <extensionModule.component />}
    </ModulePageShell>
  );
}
