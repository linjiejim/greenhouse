/**
 * Side panel — M1 shows connection state; the chat surface lands in M2.
 */

import React from 'react';
import { Button, EmptyState, Spinner, StatusDot } from '@greenhouse/ui/components/ui';
import { Unplug } from '@greenhouse/ui/lib/icons';
import { useI18n } from '@greenhouse/ui/lib/i18n';
import { useAuth } from '../lib/use-auth';

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

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-2 border-b border-edge px-3 py-2 text-sm">
        <StatusDot color="success" size="sm" />
        <span className="font-medium">{auth.user.nickname}</span>
        <span className="ml-auto truncate font-mono text-[11px] text-fg-faint">{new URL(auth.baseUrl).host}</span>
      </header>
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <p className="text-sm text-fg-muted">{t('panel.chatComingSoon')}</p>
      </div>
    </div>
  );
}
