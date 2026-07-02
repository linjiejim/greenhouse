/**
 * Side panel — auth gate + chat view.
 */

import React from 'react';
import { Button, EmptyState, Spinner } from '@greenhouse/ui/components/ui';
import { Unplug } from '@greenhouse/ui/lib/icons';
import { useI18n } from '@greenhouse/ui/lib/i18n';
import { useAuth } from '../lib/use-auth';
import { ChatView } from './chat-view';

export function SidePanelApp() {
  const { t } = useI18n();
  const { auth, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="p-4">
        <EmptyState
          icon={Unplug}
          title={t('panel.notConnectedTitle')}
          description={t('panel.notConnectedHint')}
          action={<Button onClick={() => chrome.runtime.openOptionsPage()}>{t('panel.openSettings')}</Button>}
        />
      </div>
    );
  }

  return <ChatView />;
}
