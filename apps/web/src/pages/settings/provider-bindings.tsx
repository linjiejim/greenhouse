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
import { WeComBindingCard } from './wecom-binding';
import { FeishuBindingCard } from './feishu-binding';
import { ConnectorsSection } from './connectors-section';

export function ProviderBindingsPanel() {
  return (
    <ModulePage moduleId="settings.provider-bindings" layout="form">
      <div className="space-y-4">
        <WeComBindingCard />
        <FeishuBindingCard />
        <ConnectorsSection />
      </div>
    </ModulePage>
  );
}
