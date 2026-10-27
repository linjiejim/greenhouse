/**
 * `/connectors/oauth-finish#code=&state=` — where a connector's OAuth sign-in lands in the
 * browser. The station's public callback only sends the browser here (the code and state in the
 * fragment, held back before routing); this page finishes the sign-in as the signed-in member
 * (the station refuses a state another member started), tells the window that opened it (same
 * origin only) and closes, or, when it is not a popup, offers the way to Me → Connections.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { finishConnectorSignIn } from '../../src/api/connectors';
import { useT } from '../../src/lib/i18n';
import { EntryFrame, EntryHead, EntryState } from '../../src/login/entry-frame.web';
import { heldEntryParams, releaseEntryParams } from '../../src/login/entry-links';
import { goHome } from '../../src/shell/nav';
import { CLIENT_ROUTES } from '../../src/shared/client-routes';
import { CONNECTOR_CONNECT_MESSAGE_TYPE, type ConnectorConnectMessage } from '../../src/shared/greenhouse-types';

type Phase = { kind: 'working' } | { kind: 'done'; name: string } | { kind: 'failed'; reason: string };

export default function ConnectorOAuthFinish() {
  const t = useT();
  const router = useRouter();
  const [params] = useState(() => heldEntryParams(CLIENT_ROUTES.connectorFinish));
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });
  const [popup] = useState(() => !!window.opener && window.opener !== window);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    releaseEntryParams(CLIENT_ROUTES.connectorFinish);
    const tell = (ok: boolean, connectorId: string) => {
      if (!popup) return;
      const message: ConnectorConnectMessage = { type: CONNECTOR_CONNECT_MESSAGE_TYPE, connector_id: connectorId, ok };
      window.opener.postMessage(message, window.location.origin);
      window.setTimeout(() => window.close(), 600);
    };
    const code = params?.get('code');
    const state = params?.get('state');
    const connectorId = params?.get('connector_id') ?? '';
    if (!code || !state) {
      setPhase({ kind: 'failed', reason: (params?.get('error') ?? 'missing_code').slice(0, 64) });
      tell(false, connectorId);
      return;
    }
    void finishConnectorSignIn(code, state).then((result) => {
      if (result.ok) {
        setPhase({ kind: 'done', name: result.data.connector.name });
        tell(true, result.data.connector_id);
      } else {
        setPhase({ kind: 'failed', reason: result.message });
        tell(false, connectorId);
      }
    });
  }, [params, popup]);

  const title = t('connectors.title');
  return (
    <EntryFrame label={title} testID="connector-finish">
      <EntryHead title={title} />
      <div data-phase={phase.kind} data-testid="connector-finish-phase">
        {phase.kind === 'working' ? (
          <EntryState tone="working" title={t('entry.connector.working')} />
        ) : phase.kind === 'done' ? (
          <EntryState
            tone="success"
            title={t('entry.connector.done', { name: phase.name })}
            detail={popup ? t('entry.connector.closing') : undefined}
          />
        ) : (
          <EntryState tone="danger" title={t('entry.connector.failed')} detail={phase.reason || undefined} />
        )}
      </div>
      {phase.kind !== 'working' && !popup ? (
        <div className="gh-entry-row">
          <button type="button" className="gh-entry-secondary" onClick={() => goHome(router)}>
            {t('entry.back')}
          </button>
          <button
            type="button"
            className="gh-entry-primary"
            onClick={() => router.replace(CLIENT_ROUTES.connections as never)}
          >
            {t('entry.connector.toConnections')}
          </button>
        </div>
      ) : null}
    </EntryFrame>
  );
}
