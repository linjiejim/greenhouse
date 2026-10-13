/**
 * The computer's screen through noVNC (AGNT-18). Watching and taking over are the same
 * picture: `control` sends keys and clicks, `view` cannot (the server drops input on a view
 * ticket too). Reconnects on demand; scales to the space it has.
 */

import { useEffect, useRef, useState } from 'react';
import { MousePointer2, RefreshCw } from 'lucide-react';
import { Button, ErrorBox, Spinner } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type RFB from '@novnc/novnc';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';

type State = 'connecting' | 'connected' | 'closed' | 'failed';

export function ComputerScreen({
  agentId,
  control,
  onControlChange,
}: {
  agentId: string;
  control: boolean;
  /** Offers the take-over switch when given. */
  onControlChange?: (control: boolean) => void;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const client = useRef<RFB | null>(null);
  const [state, setState] = useState<State>('connecting');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState('connecting');
    void (async () => {
      try {
        const [{ default: RFBClient }, url] = await Promise.all([
          import('@novnc/novnc'),
          api.agents.computerSocket(agentId, control ? 'control' : 'view'),
        ]);
        if (!live || !host.current) return;
        const rfb = new RFBClient(host.current, url, { shared: true });
        rfb.viewOnly = !control;
        rfb.scaleViewport = true;
        rfb.background = 'transparent';
        rfb.addEventListener('connect', () => live && setState('connected'));
        rfb.addEventListener('disconnect', (event) => {
          if (!live) return;
          setState((event as CustomEvent<{ clean: boolean }>).detail?.clean ? 'closed' : 'failed');
        });
        client.current = rfb;
      } catch {
        if (live) setState('failed');
      }
    })();
    return () => {
      live = false;
      client.current?.disconnect();
      client.current = null;
    };
  }, [agentId, control, attempt]);

  return (
    <div className="app-screen">
      <div className="app-screen-bar">
        <span className="app-muted">
          {state === 'connecting'
            ? t('computer.connecting')
            : state === 'connected'
              ? control
                ? t('computer.controlling')
                : t('computer.watching')
              : t('computer.disconnected')}
        </span>
        <span className="app-page-header-spacer" />
        {onControlChange && (
          <Button size="sm" kind={control ? 'primary' : 'secondary'} onClick={() => onControlChange(!control)}>
            <MousePointer2 size={icon.sm} />
            {control ? t('computer.handBackView') : t('computer.takeOver')}
          </Button>
        )}
        {(state === 'closed' || state === 'failed') && (
          <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>
            <RefreshCw size={icon.sm} />
            {t('computer.reconnect')}
          </Button>
        )}
      </div>
      <div className="app-screen-canvas" ref={host}>
        {state === 'connecting' && (
          <div className="app-center">
            <Spinner />
          </div>
        )}
        {state === 'failed' && (
          <div className="app-center">
            <ErrorBox onRetry={() => setAttempt((value) => value + 1)}>{t('computer.failedToConnect')}</ErrorBox>
          </div>
        )}
      </div>
    </div>
  );
}
