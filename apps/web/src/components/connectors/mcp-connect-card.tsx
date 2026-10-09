/**
 * The "Connect X" card — what `mcp_call` answers when the member has not
 * connected a connector that runs on their own account (spec
 * 20261009-mcp-connectors D7). OAuth connectors sign in in a popup right here;
 * key connectors open the key dialog. Once connected, "Continue" asks the agent
 * to try again (when the surface can send a message for the member).
 *
 * The card reads the member's current state on mount, so an old card in the
 * history of a conversation shows "Connected" instead of asking again.
 */

import React, { useEffect, useState } from 'react';
import type { McpConnectorView, McpNeedsConnection } from '@greenhouse/types/mcp-servers';
import { Button, Spinner, toast } from '../ui';
import { CheckCircle, Key, LogIn, Plug } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { fetchMyConnectors } from '../../lib/api/connectors';
import { signInToConnector } from '../../lib/connector-sign-in';
import { ConnectorKeyDialog } from './connector-key-dialog';

export function McpConnectCard({
  data,
  onContinue,
  canAct = true,
}: {
  data: McpNeedsConnection;
  /** Sends a message as the member ("I connected X — please try again"). */
  onContinue?: (message: string) => void | Promise<void>;
  canAct?: boolean;
}) {
  const t = useT();
  const [connector, setConnector] = useState<McpConnectorView | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [continued, setContinued] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchMyConnectors()
      .then(({ connectors }) => {
        if (cancelled) return;
        const mine = connectors.find((c) => c.id === data.server_id) ?? null;
        setConnector(mine);
        if (mine?.status === 'connected') setConnected(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [data.server_id]);

  const connect = async () => {
    if (data.auth === 'per_user') {
      setKeyOpen(true);
      return;
    }
    setBusy(true);
    try {
      const outcome = await signInToConnector(data.server_id);
      if (outcome === 'connected') {
        setConnected(true);
        toast(t('connectors.connectedToast', { name: data.server_name }), 'success');
      } else if (outcome === 'failed') {
        toast(t('connectors.signInFailed'), 'error');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const body = connected
    ? t('connectors.cardConnected', { name: data.server_name })
    : data.reason === 'expired'
      ? t('connectors.cardExpired', { name: data.server_name })
      : data.auth === 'oauth'
        ? t('connectors.cardBodyOauth', { name: data.server_name })
        : t('connectors.cardBodyKey', { name: data.server_name });

  return (
    <div
      className="rounded-xl border border-edge bg-surface-card p-3"
      data-testid="mcp-connect-card"
      data-state={connected ? 'connected' : 'pending'}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-surface-muted text-fg-secondary">
          {connected ? <CheckCircle size={15} className="text-success" /> : <Plug size={15} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">
            {connected ? data.server_name : t('connectors.cardTitle', { name: data.server_name })}
          </div>
          <p className="mt-0.5 text-xs text-fg-muted">{body}</p>
        </div>
        {canAct && (
          <div className="flex flex-shrink-0 items-center gap-2">
            {connected ? (
              onContinue &&
              !continued && (
                <Button
                  size="sm"
                  onClick={() => {
                    setContinued(true);
                    void onContinue(t('connectors.continueMessage', { name: data.server_name }));
                  }}
                  data-testid="mcp-connect-continue"
                >
                  {t('connectors.cardContinue')}
                </Button>
              )
            ) : (
              <Button size="sm" disabled={busy} onClick={connect} data-testid="mcp-connect-button">
                {busy ? (
                  <Spinner className="mr-1.5 h-3.5 w-3.5" />
                ) : data.auth === 'per_user' ? (
                  <Key size={14} className="mr-1.5" />
                ) : (
                  <LogIn size={14} className="mr-1.5" />
                )}
                {data.auth === 'per_user'
                  ? t('connectors.addKey')
                  : data.reason === 'expired'
                    ? t('connectors.reconnect')
                    : t('connectors.connect')}
              </Button>
            )}
          </div>
        )}
      </div>
      {keyOpen && (
        <ConnectorKeyDialog
          connector={{
            id: data.server_id,
            name: data.server_name,
            credential_help: connector?.credential_help ?? null,
            credential_url: connector?.credential_url ?? null,
          }}
          onClose={() => setKeyOpen(false)}
          onSaved={() => {
            setKeyOpen(false);
            setConnected(true);
          }}
        />
      )}
    </div>
  );
}
