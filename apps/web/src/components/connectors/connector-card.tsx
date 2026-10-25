/** One connector (team or personal) as a card with its facts and the caller's actions. */

import React from 'react';
import type { ConnectorView } from '@greenhouse/types/connectors';
import { Tag } from '../ui';
import { AlertTriangle, Plug } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { formatDate } from '../../lib/utils';
import { ConnectorStatusTag } from './connector-status';

export function ConnectorCard({
  connector,
  actions,
  showConnections = false,
}: {
  connector: ConnectorView;
  actions: React.ReactNode;
  showConnections?: boolean;
}) {
  const t = useT();
  const enabled = connector.tools.filter((tool) => tool.enabled);
  const writes = enabled.filter((tool) => tool.kind !== 'read').length;
  return (
    <div
      className="rounded-lg border border-edge bg-surface-card p-4"
      data-testid={`connector-${connector.slug}`}
      data-connector-id={connector.id}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-secondary">
          <Plug size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">{connector.name}</span>
            <code className="text-caption text-fg-muted">{connector.handle}</code>
            {!connector.enabled && <Tag tone="neutral">{t('connectors.disabled')}</Tag>}
            <Tag tone="info">{t(`connectors.authMode.${connector.auth_mode}`)}</Tag>
            {connector.auth_kind && connector.auth_mode !== 'none' && (
              <Tag tone="neutral">{t(`connectors.authKind.${connector.auth_kind}`)}</Tag>
            )}
            {connector.private_network && <Tag tone="warning">{t('connectors.internal')}</Tag>}
            {connector.allow_external_writes && <Tag tone="warning">{t('connectors.externalWrites')}</Tag>}
            {connector.auth_mode === 'shared' && !connector.has_shared_secret && (
              <Tag tone="danger">{t('connectors.noTeamCredential')}</Tag>
            )}
            {/* The admin view counts member connections instead; the caller's own status would mislead. */}
            {!(showConnections && connector.auth_mode === 'per_member') && (
              <ConnectorStatusTag status={connector.status} />
            )}
          </div>
          {connector.description && <p className="mt-1 text-xs text-fg-muted">{connector.description}</p>}
          <p className="mt-1 truncate text-caption text-fg-faint" title={connector.url}>
            {connector.url}
          </p>
          <p className="mt-1 text-caption text-fg-muted">
            {t('connectors.toolSummary', { on: enabled.length, total: connector.tools.length, writes })}
            {connector.tools_refreshed_at &&
              ` · ${t('connectors.refreshedAt', { at: formatDate(connector.tools_refreshed_at) })}`}
            {showConnections &&
              connector.auth_mode === 'per_member' &&
              ` · ${t('connectors.connectionCount', { count: connector.connection_count })}`}
          </p>
          {connector.last_error && (
            <p className="mt-1 flex items-start gap-1 text-xs text-danger">
              <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
              <span className="break-all">{connector.last_error}</span>
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
      </div>
    </div>
  );
}
