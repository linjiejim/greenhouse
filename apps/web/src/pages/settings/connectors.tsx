/**
 * Connectors — Settings sub-page: a member's own connections to the MCP
 * servers an administrator installed (spec 20261009-mcp-connectors).
 *
 * One card per enabled connector. Public and team-credential ones need
 * nothing ("Ready"); the ones that use the member's own account offer
 * Connect (OAuth sign-in in a popup) or Add key (verified once, stored
 * encrypted). Keys and tokens never come back from the server — the page only
 * ever shows states.
 *
 * `#/settings/connectors?connect=<id>` (the chat's Connect card for a key
 * connector) opens that connector's key dialog directly.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { McpConnectorView } from '@greenhouse/types/mcp-servers';
import { ModulePage } from '../../components/app/module-page';
import { Button, EmptyState, Spinner, Tag, toast } from '../../components/ui';
import { ConnectorKeyDialog } from '../../components/connectors/connector-key-dialog';
import { CheckCircle, Key, LogIn, Plug, RefreshCw, Unplug } from '../../lib/icons';
import { formatDate } from '../../lib/utils';
import { useT } from '../../lib/i18n';
import { disconnectConnector, fetchMyConnectors, testConnector } from '../../lib/api/connectors';
import { signInToConnector } from '../../lib/connector-sign-in';

function StatusTag({ connector }: { connector: McpConnectorView }) {
  const t = useT();
  switch (connector.status) {
    case 'connected':
      return (
        <Tag tone="success">
          <CheckCircle size={11} className="mr-0.5" />
          {t('connectors.statusConnected')}
        </Tag>
      );
    case 'expired':
      return <Tag tone="warning">{t('connectors.statusExpired')}</Tag>;
    case 'not_connected':
      return <Tag tone="neutral">{t('connectors.statusNotConnected')}</Tag>;
    default:
      return <Tag tone="neutral">{t('connectors.statusReady')}</Tag>;
  }
}

function authLabel(t: ReturnType<typeof useT>, connector: McpConnectorView): string {
  switch (connector.auth_mode) {
    case 'oauth':
      return t('connectors.authOauth');
    case 'per_user':
      return t('connectors.authPerUser');
    case 'shared':
      return t('connectors.authShared');
    default:
      return t('connectors.authNone');
  }
}

function ConnectorCard({
  connector,
  highlighted,
  onChanged,
  onAddKey,
}: {
  connector: McpConnectorView;
  highlighted: boolean;
  onChanged: () => void;
  onAddKey: (connector: McpConnectorView) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState<null | 'connect' | 'disconnect' | 'test'>(null);
  const personal = connector.auth_mode === 'oauth' || connector.auth_mode === 'per_user';
  const connected = connector.status === 'connected';

  const connect = async () => {
    setBusy('connect');
    try {
      const outcome = await signInToConnector(connector.id);
      if (outcome === 'connected') toast(t('connectors.connectedToast', { name: connector.name }), 'success');
      else if (outcome === 'failed') toast(t('connectors.signInFailed'), 'error');
      else toast(t('connectors.signInClosed'), 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const disconnect = async () => {
    setBusy('disconnect');
    try {
      await disconnectConnector(connector.id);
      toast(t('connectors.disconnected', { name: connector.name }), 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const test = async () => {
    setBusy('test');
    try {
      const result = await testConnector(connector.id);
      if (result.ok) toast(t('connectors.testOk', { name: connector.name, count: result.tool_count ?? 0 }), 'success');
      else toast(t('connectors.testFailed', { name: connector.name, error: result.error ?? '' }), 'error');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  return (
    <div
      id={`connector-${connector.id}`}
      data-testid={`connector-card-${connector.slug}`}
      className={`rounded-xl border bg-surface-card p-4 transition-shadow ${
        highlighted ? 'border-primary-400 ring-2 ring-primary-200' : 'border-edge'
      }`}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-surface-muted text-fg-secondary">
          <Plug size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">{connector.name}</span>
            <code className="rounded bg-surface-muted px-1 py-px text-[10px] text-fg-secondary">{connector.slug}</code>
            <StatusTag connector={connector} />
          </div>
          <p className="mt-0.5 text-xs text-fg-faint">
            {authLabel(t, connector)}
            {' · '}
            {connector.tool_count > 0
              ? t('connectors.tools', { count: connector.tool_count, readOnly: connector.read_only_tool_count })
              : t('connectors.noToolsYet')}
          </p>
          {connector.description && <p className="mt-1.5 text-xs text-fg-muted">{connector.description}</p>}
          {connected && connector.connected_at && (
            <p className="mt-1 text-[11px] text-fg-faint">
              {t('connectors.connectedSince', { at: formatDate(connector.connected_at) })}
            </p>
          )}
          {connector.status === 'expired' && connector.error && (
            <p className="mt-1 text-[11px] text-warning">{t('connectors.expiredHint', { error: connector.error })}</p>
          )}
        </div>
        {personal && (
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
            {connected && (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={test}>
                {busy === 'test' ? (
                  <Spinner className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <RefreshCw size={13} className="mr-1.5" />
                )}
                {t('connectors.test')}
              </Button>
            )}
            {connector.auth_mode === 'oauth' ? (
              <Button
                size="sm"
                variant={connected ? 'outline' : 'default'}
                disabled={busy !== null}
                onClick={connect}
                data-testid={`connector-connect-${connector.slug}`}
              >
                {busy === 'connect' ? (
                  <Spinner className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <LogIn size={14} className="mr-1.5" />
                )}
                {connected || connector.status === 'expired' ? t('connectors.reconnect') : t('connectors.connect')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant={connected ? 'outline' : 'default'}
                disabled={busy !== null}
                onClick={() => onAddKey(connector)}
                data-testid={`connector-key-${connector.slug}`}
              >
                <Key size={14} className="mr-1.5" />
                {connected ? t('connectors.replaceKey') : t('connectors.addKey')}
              </Button>
            )}
            {(connected || connector.status === 'expired') && (
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={disconnect}>
                {busy === 'disconnect' ? (
                  <Spinner className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <Unplug size={14} className="mr-1.5" />
                )}
                {connector.auth_mode === 'oauth' ? t('connectors.disconnect') : t('connectors.removeKey')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** `?connect=<id>` from the hash query, if any. */
function requestedConnectorId(): number | null {
  const query = window.location.hash.split('?')[1];
  const raw = query ? new URLSearchParams(query).get('connect') : null;
  const id = raw ? Number(raw) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function ConnectorsPanel() {
  const t = useT();
  const [state, setState] = useState<{ enabled: boolean; connectors: McpConnectorView[] } | null>(null);
  const [keyFor, setKeyFor] = useState<McpConnectorView | null>(null);
  const [highlight, setHighlight] = useState<number | null>(() => requestedConnectorId());

  const load = useCallback(async () => {
    try {
      setState(await fetchMyConnectors());
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      setState({ enabled: false, connectors: [] });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The chat's Connect card for a key connector lands here: open its dialog once.
  useEffect(() => {
    if (!state || highlight === null) return;
    const target = state.connectors.find((c) => c.id === highlight);
    if (target?.auth_mode === 'per_user' && target.status !== 'connected') setKeyFor(target);
    document.getElementById(`connector-${highlight}`)?.scrollIntoView({ block: 'center' });
    window.location.hash = window.location.hash.split('?')[0];
    const timer = window.setTimeout(() => setHighlight(null), 2500);
    return () => window.clearTimeout(timer);
    // Only on the first load that has the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state !== null]);

  const sorted = useMemo(() => {
    if (!state) return [];
    const rank = (c: McpConnectorView) => (c.auth_mode === 'oauth' || c.auth_mode === 'per_user' ? 0 : 1);
    return [...state.connectors].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [state]);

  return (
    <ModulePage
      moduleId="settings.connectors"
      layout="form"
      notice={state?.enabled ? <p className="text-xs text-fg-muted">{t('connectors.intro')}</p> : undefined}
    >
      {!state ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : !state.enabled ? (
        <EmptyState icon={Plug} title={t('connectors.disabledTitle')} description={t('connectors.disabledDesc')} />
      ) : sorted.length === 0 ? (
        <EmptyState icon={Plug} title={t('connectors.noneTitle')} description={t('connectors.noneDesc')} />
      ) : (
        <div className="space-y-3" data-testid="connectors-list">
          {sorted.map((connector) => (
            <ConnectorCard
              key={connector.id}
              connector={connector}
              highlighted={highlight === connector.id}
              onChanged={() => void load()}
              onAddKey={setKeyFor}
            />
          ))}
        </div>
      )}
      {keyFor && (
        <ConnectorKeyDialog
          connector={keyFor}
          onClose={() => setKeyFor(null)}
          onSaved={() => {
            setKeyFor(null);
            void load();
          }}
        />
      )}
    </ModulePage>
  );
}
