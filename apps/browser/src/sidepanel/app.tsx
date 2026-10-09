/**
 * Side panel — auth gate + chat view.
 *
 * Three gate states: no station yet (connect), active station signed out
 * (sign in again), signed in (chat). ChatView is keyed by station id so
 * switching stations remounts chat/profiles/history cleanly.
 */

import React from 'react';
import { Button, EmptyState, Spinner } from '@greenhouse/ui/components/ui';
import { Unplug, LogIn } from '@greenhouse/ui/lib/icons';
import { useI18n } from '@greenhouse/ui/lib/i18n';
import { AppLinkOriginContext } from '@greenhouse/ui/components/markdown';
import { useAuth } from '../lib/use-auth';
import { ChatView } from './chat-view';

export function SidePanelApp() {
  const { t } = useI18n();
  const { auth, station, loading } = useAuth();

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
          icon={station ? LogIn : Unplug}
          title={station ? t('panel.signedOutTitle') : t('panel.notConnectedTitle')}
          description={station ? t('panel.signedOutHint', { name: station.name }) : t('panel.notConnectedHint')}
          action={<Button onClick={() => chrome.runtime.openOptionsPage()}>{t('panel.openSettings')}</Button>}
        />
      </div>
    );
  }

  // In-app links in answers (`#/projects/42`) open in this station's web app.
  return (
    <AppLinkOriginContext.Provider value={station?.baseUrl ?? null}>
      <ChatView key={auth.stationId} />
    </AppLinkOriginContext.Provider>
  );
}
