/**
 * Connections — Settings sub-page for third-party identity bindings.
 *
 * Each card renders only when the deployment has the matching integration
 * configured (WeCom corp app / Feishu app), so an unconfigured instance shows
 * an empty page rather than dead controls.
 */

import React from 'react';
import { ModulePage } from '../../components/app/module-page';
import { WeComBindingCard } from './wecom-binding';
import { FeishuBindingCard } from './feishu-binding';

export function ProviderBindingsPanel() {
  return (
    <ModulePage moduleId="settings.provider-bindings" layout="form">
      <div className="space-y-4">
        <WeComBindingCard />
        <FeishuBindingCard />
      </div>
    </ModulePage>
  );
}
