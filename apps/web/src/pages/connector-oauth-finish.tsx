/**
 * `#/connectors/oauth-finish` — where a connector's OAuth sign-in lands.
 *
 * The provider redirects to the public callback, which only sends the browser
 * here with `code` + `state` (or an `error`). This page finishes the sign-in
 * as the logged-in member (the API refuses a state another member started),
 * tells the window that opened it, and closes — or, when it was not a popup,
 * returns to Settings → Connections.
 */

import React, { useEffect, useRef, useState } from 'react';
import { CONNECTOR_CONNECT_MESSAGE_TYPE, type ConnectorConnectMessage } from '@greenhouse/types/connectors';
import { Button, Spinner } from '../components/ui';
import { CheckCircle, XCircle } from '../lib/icons';
import { useT } from '../lib/i18n';
import { finishConnectorSignIn } from '../lib/api/connectors';

const SETTINGS_HASH = '#/settings/provider-bindings';

function readParams(): URLSearchParams {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '');
}

export function ConnectorOAuthFinishPage() {
  const t = useT();
  const [state, setState] = useState<
    { phase: 'working' } | { phase: 'done'; name: string } | { phase: 'failed'; error: string }
  >({ phase: 'working' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = readParams();
    const tell = (message: ConnectorConnectMessage) => {
      if (window.opener && window.opener !== window) {
        window.opener.postMessage(message, window.location.origin);
        window.setTimeout(() => window.close(), 600);
      }
    };
    const code = params.get('code');
    const signInState = params.get('state');
    const connectorId = params.get('connector_id') ?? '';
    if (!code || !signInState) {
      const error = params.get('error') ?? 'missing_code';
      setState({ phase: 'failed', error });
      tell({ type: CONNECTOR_CONNECT_MESSAGE_TYPE, connector_id: connectorId, ok: false });
      return;
    }
    void finishConnectorSignIn(code, signInState)
      .then((result) => {
        setState({ phase: 'done', name: result.connector.name });
        tell({ type: CONNECTOR_CONNECT_MESSAGE_TYPE, connector_id: result.connector_id, ok: true });
      })
      .catch((err: unknown) => {
        setState({ phase: 'failed', error: err instanceof Error ? err.message : String(err) });
        tell({ type: CONNECTOR_CONNECT_MESSAGE_TYPE, connector_id: connectorId, ok: false });
      });
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-canvas p-6">
      <div
        className="w-full max-w-sm rounded-xl border border-edge bg-surface-card p-6 text-center"
        data-testid="connector-oauth-finish"
        data-phase={state.phase}
      >
        {state.phase === 'working' && (
          <div className="flex flex-col items-center gap-3 text-sm text-fg-muted">
            <Spinner className="h-5 w-5" />
            {t('connectors.finishing')}
          </div>
        )}
        {state.phase === 'done' && (
          <div className="flex flex-col items-center gap-3">
            <CheckCircle size={28} className="text-success" />
            <p className="text-sm text-fg">{t('connectors.finishDone', { name: state.name })}</p>
          </div>
        )}
        {state.phase === 'failed' && (
          <div className="flex flex-col items-center gap-3">
            <XCircle size={28} className="text-danger" />
            <p className="text-sm text-fg">{t('connectors.finishFailed')}</p>
            <p className="break-all text-xs text-fg-muted">{state.error}</p>
          </div>
        )}
        {state.phase !== 'working' && !window.opener && (
          <Button className="mt-4" size="sm" onClick={() => (window.location.hash = SETTINGS_HASH)}>
            {t('connectors.backToSettings')}
          </Button>
        )}
      </div>
    </div>
  );
}
