/**
 * Runtime config: the workspace settings registry (main model, images, web search, the model
 * gateway, then one group per plugin), straight from GET /api/admin/settings — a new registry
 * entry appears here without page changes. Branding and team context have their own sections.
 */
import React from 'react';
import { useT } from '../lib/i18n';
import { AdminPage } from './kit.web';
import { SettingsForm } from './settings-form.web';

export default function RuntimeConfigSection() {
  const t = useT();
  return (
    <AdminPage title={t('admin.sections.runtime-config')} testID="admin-runtime-config">
      <SettingsForm intro={t('admin.runtime.intro')} />
    </AdminPage>
  );
}
