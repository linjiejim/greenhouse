/**
 * Connections — Settings sub-page for third-party identity bindings and the
 * connectors (outside MCP services) my agent can use.
 *
 * Each binding card renders only when the deployment has the matching
 * integration configured (WeCom corp app / Feishu app); the connectors
 * section only when my account has `mcp_call`.
 */

import React from 'react';
import { ModulePage } from '../../components/app/module-page';
import { extensionIdentityProviders } from '../../extensions';
import { useExtensionsStore } from '../../stores/extensions-store';
import { ConnectorsSection } from './connectors-section';

export function ProviderBindingsPanel() {
  useExtensionsStore((s) => s.extensions);
  useExtensionsStore((s) => s.extensions);
  return (
    <ModulePage moduleId="settings.provider-bindings" layout="form">
      <div className="space-y-4">
        {extensionIdentityProviders().map(({ id, binding: Binding }) => (Binding ? <Binding key={id} /> : null))}
        <ConnectorsSection />
      </div>
    </ModulePage>
  );
}
