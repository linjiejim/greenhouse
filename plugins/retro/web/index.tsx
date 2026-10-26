import React from 'react';
import { defineWebExtension, ModulePage, ScrollText, useT } from '@greenhouse/web/extension-kit';
import manifest from '../manifest.js';
import { RetroButton } from './button.js';
import en from './messages/en.js';
import zh from './messages/zh.js';
function RetroPanel() {
  const t = useT();
  return (
    <ModulePage
      moduleId="admin.retro"
      layout="form"
      actions={<RetroButton />}
      notice={<p className="text-xs text-fg-muted">{t('ext.retro.description')}</p>}
    >
      {null}
    </ModulePage>
  );
}
export default defineWebExtension({
  ...manifest,
  messages: { en, zh },
  modules: [
    {
      key: 'retro',
      parent: 'administration',
      labelKey: 'ext.retro.title',
      descriptionKey: 'ext.retro.description',
      icon: ScrollText,
      component: RetroPanel,
      requireRole: ['super'],
    },
  ],
  slots: [{ slot: 'feedback.actions', component: RetroButton }],
});
