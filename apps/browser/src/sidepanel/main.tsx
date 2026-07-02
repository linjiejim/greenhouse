import '../styles.css';
import '../i18n/setup';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@greenhouse/ui/lib/i18n';
import { initTheme } from '@greenhouse/ui/lib/theme';
import { SidePanelApp } from './app';

initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <SidePanelApp />
    </I18nProvider>
  </React.StrictMode>,
);
