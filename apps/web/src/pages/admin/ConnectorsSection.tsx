/**
 * 管理 → 连接器 (ADM-08): the MCP servers installed here. Each row says how members authenticate,
 * how many tools Agents may call, how many members connected and whether its last listing or
 * test failed; it opens the connector's drawer. 添加连接器 installs from the catalog, the MCP
 * Registry or an address.
 */

import { useState } from 'react';
import { ChevronRight, Plug, Plus } from 'lucide-react';
import { Button, Empty, ErrorBox, Skeleton, StatusBadge } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Connector } from '@greenhouse/contract';
import { useAdminConnectors } from '../../data/connectors';
import { useI18n, type Translate } from '../../lib/i18n';
import { AddConnectorDrawer } from './AddConnectorDrawer';
import { ConnectorDrawer, connectorStatus } from './ConnectorDrawer';
import { MODE_LABEL } from './ConnectorFields';

function metaOf(connector: Connector, t: Translate): string {
  const allowed = connector.tools.filter((tool) => tool.allowed).length;
  return [
    connector.slug,
    connector.last_error ??
      [
        t(MODE_LABEL[connector.auth_mode]),
        t('connectors.toolCount', { count: allowed }),
        t('connectors.people', { count: connector.connection_count }),
      ].join(' · '),
  ].join(' · ');
}

export function ConnectorsSection() {
  const { t } = useI18n();
  const connectors = useAdminConnectors();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const items = connectors.data?.items ?? [];
  return (
    <section className="app-section">
      <div className="app-section-heading">
        <h2 className="app-section-title">{t('connectors.count', { count: items.length })}</h2>
        <Button kind="primary" onClick={() => setAdding(true)}>
          <Plus size={icon.md} />
          {t('connectors.add')}
        </Button>
      </div>
      {connectors.isPending ? (
        <Skeleton lines={4} />
      ) : connectors.isError ? (
        <ErrorBox onRetry={() => void connectors.refetch()}>{t('common.error')}</ErrorBox>
      ) : items.length ? (
        <ul className="app-list app-bordered">
          {items.map((connector) => {
            const status = connectorStatus(connector);
            return (
              <li key={connector.id}>
                <button type="button" className="app-list-row" onClick={() => setOpen(connector.id)}>
                  <span className="app-list-main">
                    <span className="app-list-title">{connector.name}</span>
                    <span className="app-list-meta">{metaOf(connector, t)}</span>
                  </span>
                  <StatusBadge status={t(status.word)} tone={status.tone} />
                  <ChevronRight size={icon.md} className="app-row-muted" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty icon={<Plug />} title={t('connectors.none')} />
      )}
      {adding && (
        <AddConnectorDrawer
          onClose={() => setAdding(false)}
          onInstalled={(connector) => {
            setAdding(false);
            setOpen(connector.id);
          }}
        />
      )}
      {open && <ConnectorDrawer id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
