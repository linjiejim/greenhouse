/**
 * Plugins (GET /api/admin/plugins): the deployment's read-only inventory — compiled and enabled
 * plugins, version, SDK, migrations and boot state. Enabling one is configuration plus a restart.
 */
import React, { useCallback, useState } from 'react';
import { get } from '../api/client';
import { useResource } from '../data/use-resource';
import { useT } from '../lib/i18n';
import { Icon } from '../ui/core';
import { AdminDialog, AdminPage, Badge, Callout, SectionState, type Tone } from './kit.web';

interface PluginStatus {
  id: string;
  name: string;
  compiled: boolean;
  enabled: boolean;
  sdk: number | null;
  version: string | null;
  dependsOn: string[];
  bootState: 'disabled' | 'not-run' | 'ready' | 'error';
  bootErrors: string[];
  migrationState: 'none' | 'applied' | 'pending' | 'error';
  migrationError: string | null;
  migrations: { name: string; state: 'applied' | 'pending' | 'skipped' | 'missing'; drifted: boolean }[];
}

const MIGRATION_TONE: Record<PluginStatus['migrationState'], Tone> = {
  none: 'neutral',
  applied: 'neutral',
  pending: 'warning',
  error: 'danger',
};
const BOOT_TONE: Record<PluginStatus['bootState'], Tone> = {
  disabled: 'neutral',
  'not-run': 'neutral',
  ready: 'success',
  error: 'danger',
};

export default function PluginsSection() {
  const t = useT();
  const list = useResource(useCallback(() => get<{ plugins: PluginStatus[] }>('/api/admin/plugins'), []));
  const [open, setOpen] = useState<PluginStatus | null>(null);
  const plugins = list.data?.plugins;
  const errors = (p: PluginStatus) => [...p.bootErrors, ...(p.migrationError ? [p.migrationError] : [])].join('; ');
  return (
    <AdminPage
      title={t('admin.sections.plugins')}
      testID="admin-plugins"
      actions={
        <button
          className="gh-icon-button"
          aria-label={t('common.refresh')}
          disabled={list.loading}
          onClick={() => void list.refresh()}
        >
          <Icon name="refresh" size={16} />
        </button>
      }
    >
      <Callout tone="info" icon="alertCircle">
        {t('admin.plugins.notice')}
      </Callout>
      {plugins?.length ? (
        <table className="gh-data-grid gh-admin-grid">
          <thead>
            <tr>
              <th>{t('admin.plugins.name')}</th>
              <th>{t('admin.plugins.id')}</th>
              <th>{t('admin.plugins.state')}</th>
              <th>{t('admin.plugins.version')}</th>
              <th className="gh-number">{t('admin.plugins.sdk')}</th>
              <th>{t('admin.plugins.migrations')}</th>
              <th>{t('admin.plugins.boot')}</th>
              <th>{t('admin.plugins.dependsOn')}</th>
              <th>{t('admin.plugins.errors')}</th>
            </tr>
          </thead>
          <tbody>
            {plugins.map((p) => (
              <tr
                key={p.id}
                data-open=""
                tabIndex={0}
                aria-label={p.name}
                data-muted={p.enabled ? undefined : ''}
                onClick={() => setOpen(p)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpen(p);
                  }
                }}
              >
                <td>
                  <strong>{p.name}</strong>
                </td>
                <td className="gh-mono">{p.id}</td>
                <td>
                  <Badge tone={p.enabled ? 'success' : 'neutral'}>
                    {p.enabled
                      ? t('admin.plugins.on')
                      : p.compiled
                        ? t('admin.plugins.off')
                        : t('admin.plugins.notCompiled')}
                  </Badge>
                </td>
                <td>{p.version ?? '—'}</td>
                <td className="gh-number">{p.sdk ?? '—'}</td>
                <td>
                  <Badge tone={MIGRATION_TONE[p.migrationState]}>
                    {t(`admin.plugins.migration.${p.migrationState}`)}
                  </Badge>
                </td>
                <td>
                  <Badge tone={BOOT_TONE[p.bootState]}>{t(`admin.plugins.bootState.${p.bootState}`)}</Badge>
                </td>
                <td>{p.dependsOn.length ? p.dependsOn.join(', ') : '—'}</td>
                <td title={errors(p)} style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {errors(p) || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <SectionState
          loading={list.loading && !list.data}
          error={list.error}
          retry={() => void list.refresh()}
          icon="apps"
          title={t('admin.plugins.empty')}
        />
      )}
      {open ? (
        <AdminDialog title={open.name} onClose={() => setOpen(null)} testID="admin-plugin-detail">
          <div className="gh-form">
            <dl className="gh-admin-facts">
              <dt>{t('admin.plugins.id')}</dt>
              <dd className="gh-mono">{open.id}</dd>
              <dt>{t('admin.plugins.version')}</dt>
              <dd>{open.version ?? '—'}</dd>
              <dt>{t('admin.plugins.boot')}</dt>
              <dd>{t(`admin.plugins.bootState.${open.bootState}`)}</dd>
              <dt>{t('admin.plugins.dependsOn')}</dt>
              <dd>{open.dependsOn.join(', ') || '—'}</dd>
              {errors(open) ? (
                <>
                  <dt>{t('admin.plugins.errors')}</dt>
                  <dd>{errors(open)}</dd>
                </>
              ) : null}
            </dl>
            <h4 className="gh-form-heading">{t('admin.plugins.migrations')}</h4>
            {open.migrations.length ? (
              <table className="gh-data-grid gh-admin-grid">
                <tbody>
                  {open.migrations.map((file) => (
                    <tr key={file.name}>
                      <td className="gh-mono">{file.name}</td>
                      <td>
                        <Badge tone={file.state === 'pending' || file.state === 'missing' ? 'warning' : 'neutral'}>
                          {t(`admin.plugins.fileState.${file.state}`)}
                        </Badge>
                        {file.drifted ? <Badge tone="danger">{t('admin.plugins.drifted')}</Badge> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="gh-hint">{t('admin.plugins.migration.none')}</p>
            )}
          </div>
        </AdminDialog>
      ) : null}
    </AdminPage>
  );
}
