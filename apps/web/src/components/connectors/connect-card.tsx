/**
 * The "Connect X" card — what `mcp_call` answers when the member has not
 * connected (or must reconnect) a connector that runs on their own account.
 * OAuth connectors sign in in a popup right here; key connectors open the key
 * dialog. Once connected, "Continue" asks the agent to try again.
 *
 * The card reads the member's current standing on mount, so an old card in a
 * conversation's history shows "Connected" instead of asking again.
 */

import React, { useEffect, useState } from 'react';
import type { ConnectorNeedsConnection } from '@greenhouse/types/connectors';
import { Button, Spinner, toast } from '../ui';
import { CheckCircle, Key, LogIn, Plug } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { fetchMyConnectors, startConnectorSignIn } from '../../lib/api/connectors';
import { signInInPopup } from '../../lib/connector-sign-in';
import { ConnectorKeyDialog } from './connector-key-dialog';

export function ConnectorConnectCard({
  data,
  onContinue,
  canAct = true,
}: {
  data: ConnectorNeedsConnection;
  /** Sends a message as the member ("I connected X — please try again"). */
  onContinue?: (message: string) => void;
  canAct?: boolean;
}) {
  const t = useT();
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [continued, setContinued] = useState(false);
  const name = data.connector_name;

  useEffect(() => {
    let cancelled = false;
    void fetchMyConnectors()
      .then(({ team, personal }) => {
        if (cancelled) return;
        const status =
          team.find((c) => c.id === data.connector_id)?.status ??
          personal.find((c) => c.id === data.connector_id)?.status;
        if (status === 'connected') setConnected(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [data.connector_id]);

  const connect = async () => {
    if (data.auth_kind === 'key') {
      setKeyOpen(true);
      return;
    }
    setBusy(true);
    try {
      const outcome = await signInInPopup(data.connector_id, () => startConnectorSignIn(data.connector_id));
      if (outcome === 'connected') {
        setConnected(true);
        toast(t('connectors.connectedToast', { name }), 'success');
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
    ? t('connectors.cardConnected', { name })
    : data.reason === 'needs_reauth'
      ? t('connectors.cardReconnect', { name })
      : data.auth_kind === 'oauth'
        ? t('connectors.cardBodyOauth', { name })
        : t('connectors.cardBodyKey', { name });

  return (
    <div
      className="rounded-xl border border-edge bg-surface-card p-3"
      data-testid="connector-connect-card"
      data-state={connected ? 'connected' : 'pending'}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-secondary">
          {connected ? <CheckCircle size={15} className="text-success" /> : <Plug size={15} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">{connected ? name : t('connectors.cardTitle', { name })}</div>
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
                    onContinue(t('connectors.continueMessage', { name }));
                  }}
                  data-testid="connector-connect-continue"
                >
                  {t('connectors.cardContinue')}
                </Button>
              )
            ) : (
              <Button size="sm" disabled={busy} onClick={connect} data-testid="connector-connect-button">
                {busy ? (
                  <Spinner className="mr-1.5 h-3.5 w-3.5" />
                ) : data.auth_kind === 'key' ? (
                  <Key size={14} className="mr-1.5" />
                ) : (
                  <LogIn size={14} className="mr-1.5" />
                )}
                {data.auth_kind === 'key'
                  ? t('connectors.addKey')
                  : data.reason === 'needs_reauth'
                    ? t('connectors.reconnect')
                    : t('connectors.connect')}
              </Button>
            )}
          </div>
        )}
      </div>
      {keyOpen && (
        <ConnectorKeyDialog
          connector={{ id: data.connector_id, name }}
          onClose={() => setKeyOpen(false)}
          onSaved={(result) => {
            setKeyOpen(false);
            if (result.ok) setConnected(true);
          }}
        />
      )}
    </div>
  );
}
