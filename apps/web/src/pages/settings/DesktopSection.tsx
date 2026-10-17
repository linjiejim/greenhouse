/**
 * 设置 → 桌面端 (SET-09, only in the desktop app): the server, read only when the build fixed
 * it, and the version with the update waiting for a restart. Changing the server signs out of
 * the old one and restarts the app. Shortcuts and system permissions come with their features.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, ErrorBox, Skeleton } from '@greenhouse/ui/kit';
import { api } from '../../lib/api';
import { applyUpdate, checkForUpdates, useDesktopSettings, useDesktopUpdate } from '../../lib/desktop';
import { invokeDesktop } from '../../lib/desktop/shell';
import { useI18n } from '../../lib/i18n';
import { ServerForm } from '../ServerForm';

function Server() {
  const { t } = useI18n();
  const settings = useDesktopSettings();
  const [changing, setChanging] = useState(false);
  if (settings.isPending) return <Skeleton lines={1} />;
  if (settings.isError) return <ErrorBox onRetry={() => void settings.refetch()}>{t('common.error')}</ErrorBox>;
  const { apiBaseUrl, apiBaseLocked } = settings.data;
  return (
    <>
      <div className="app-setting-row">
        <span className="app-setting-text">
          <strong>{t('desktop.server')}</strong>
          <span>{apiBaseUrl}</span>
          {apiBaseLocked && <span>{t('desktop.serverLocked')}</span>}
        </span>
        {!apiBaseLocked && !changing && (
          <Button size="sm" onClick={() => setChanging(true)}>
            {t('server.change')}
          </Button>
        )}
      </div>
      {changing && (
        <div className="app-setting-row">
          <ServerForm
            className="app-form"
            initial={apiBaseUrl}
            description={t('desktop.switchHint')}
            submitLabel={t('desktop.switch')}
            // Ends the session on the old server without re-rendering into sign-in first.
            beforeSwitch={() => api.auth.logout()}
            onCancel={() => setChanging(false)}
          />
        </div>
      )}
    </>
  );
}

function Version() {
  const { t } = useI18n();
  const update = useDesktopUpdate();
  const info = useQuery({ queryKey: ['desktop', 'info'], queryFn: () => invokeDesktop('desktop_info') });
  const [checked, setChecked] = useState<'idle' | 'checking' | 'current' | 'failed'>('idle');
  const check = async () => {
    setChecked('checking');
    setChecked((await checkForUpdates()) ? 'current' : 'failed');
  };
  let status = '';
  if (update.kind === 'web' || update.kind === 'shell') status = t('desktop.updateReady');
  else if (update.kind === 'shell_required') status = t('desktop.needsNewApp');
  else if (checked === 'current') status = t('desktop.upToDate');
  else if (checked === 'failed') status = t('desktop.checkFailed');
  return (
    <div className="app-setting-row">
      <span className="app-setting-text">
        <strong>{t('desktop.version')}</strong>
        {info.data && (
          <span>{t('desktop.versionValue', { shell: info.data.shellVersion, web: info.data.webBundleVersion })}</span>
        )}
        {status && <span role="status">{status}</span>}
      </span>
      {update.kind === 'web' || update.kind === 'shell' ? (
        <Button size="sm" kind="primary" onClick={() => void applyUpdate()}>
          {t('desktop.restartToUpdate')}
        </Button>
      ) : (
        update.kind === 'none' && (
          <Button size="sm" loading={checked === 'checking'} onClick={() => void check()}>
            {t('desktop.checkUpdates')}
          </Button>
        )
      )}
    </div>
  );
}

export function DesktopSection() {
  return (
    <section className="app-settings-group">
      <Server />
      <Version />
    </section>
  );
}
