/**
 * The member's terminal on the computer (tmux as the `agent` user, so it survives a reload):
 * xterm.js over the terminal socket, binary both ways, a JSON resize frame when it changes size.
 */

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import '@xterm/xterm/css/xterm.css';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';

export function ComputerTerminal({ agentId }: { agentId: string }) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    let socket: WebSocket | null = null;
    let dispose = () => undefined as void;
    setClosed(false);
    void (async () => {
      const [{ Terminal }, { FitAddon }, url] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        api.agents.computerSocket(agentId, 'terminal'),
      ]);
      if (!live || !host.current) return;
      const styles = getComputedStyle(document.documentElement);
      const terminal = new Terminal({
        cursorBlink: true,
        fontFamily: styles.getPropertyValue('--gh-font-mono') || 'monospace',
        fontSize: 13,
        theme: {
          background: styles.getPropertyValue('--gh-canvas').trim() || '#ffffff',
          foreground: styles.getPropertyValue('--gh-text').trim() || '#1c1c1e',
        },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host.current);
      fit.fit();
      socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      const encoder = new TextEncoder();
      const resize = () => {
        fit.fit();
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      };
      socket.onopen = resize;
      socket.onmessage = (event) => {
        terminal.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer));
      };
      socket.onclose = () => live && setClosed(true);
      const typing = terminal.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
      });
      const observer = new ResizeObserver(resize);
      observer.observe(host.current);
      terminal.focus();
      dispose = () => {
        observer.disconnect();
        typing.dispose();
        terminal.dispose();
      };
    })().catch(() => live && setClosed(true));
    return () => {
      live = false;
      socket?.close();
      dispose();
    };
  }, [agentId, attempt]);

  return (
    <div className="app-terminal">
      {closed && (
        <div className="app-screen-bar">
          <span className="app-muted">{t('computer.disconnected')}</span>
          <span className="app-page-header-spacer" />
          <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>
            <RefreshCw size={icon.sm} />
            {t('computer.reconnect')}
          </Button>
        </div>
      )}
      <div className="app-terminal-host" ref={host} />
    </div>
  );
}
