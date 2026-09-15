/**
 * Assistant overlay host.
 *
 * This file owns only the floating shell, page-context attachment and compact
 * history picker. Conversation behavior is the shared ConversationPane.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatTurnEnvironment } from '@greenhouse/types/api';
import { Badge, IconButton, ResizeHandle, Spinner } from '../ui';
import { OverlayPanel } from '../app/overlay-panel';
import { useAgentContext } from '../agent-context';
import { ConversationPane } from '../conversation/conversation-pane';
import { getContextHint, getContextLabel, getQuickActions } from './agent-helpers';
import { snapshotClientActions } from '../../lib/client-actions/registry';
import { pageActionScopeId } from '../../lib/page-action-scope';
import { pageContextKey } from '../../lib/page-context-key';
import { getContextIcon } from '../../lib/icons';
import { Bot, Clock, Maximize2, Plus, X } from '../../lib/icons';
import * as api from '../../lib/api';
import { useSessionManager } from '../../lib/session-manager';
import { useT } from '../../lib/i18n';
import { onAttachment, type AgentAttachment } from '../../lib/desktop/attach';

type DesktopAttachmentRequest = AgentAttachment & { id: number };

export function AssistantNavButton() {
  const t = useT();
  const { toggle, isOpen } = useAgentContext();
  const { activeSessions } = useSessionManager();

  const activeCount = useMemo(() => {
    let count = 0;
    for (const session of activeSessions.values()) {
      if (session.status === 'streaming') count += 1;
    }
    return count;
  }, [activeSessions]);

  // Icon-only, like the Search button beside it in the sidebar brand row: the pair reads as one row of
  // equal-weight global affordances, and the tooltip carries the name.
  return (
    <IconButton
      label={t('app.agentPanel')}
      tooltip="bottom"
      onClick={toggle}
      className={isOpen ? 'bg-primary-subtle text-primary-fg-strong' : ''}
    >
      <Bot size={16} />
      {activeCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full text-[10px] font-bold text-white bg-primary-500 animate-pulse">
          {activeCount}
        </span>
      )}
    </IconButton>
  );
}

export function AssistantPanel() {
  const { isOpen, close, pageContext, launchAssistant, launchRequest, clearLaunchRequest } = useAgentContext();
  const t = useT();
  const [rendered, setRendered] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [contextDismissed, setContextDismissed] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historySessions, setHistorySessions] = useState<api.Session[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [desktopAttachment, setDesktopAttachment] = useState<DesktopAttachmentRequest | null>(null);
  const desktopAttachmentIdRef = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(() => Math.max(480, Math.round(window.innerWidth * 0.8)));
  const [panelHeight, setPanelHeight] = useState(() => window.innerHeight - 64);
  const contextIdentity = pageContextKey(pageContext);

  useEffect(() => {
    if (isOpen) {
      setRendered(true);
      setClosing(false);
    } else if (rendered) {
      setClosing(true);
    }
  }, [isOpen, rendered]);

  const handleExited = useCallback(() => {
    setRendered(false);
    setClosing(false);
  }, []);

  // Desktop captures (screenshot shortcut, selection bar) land here: files go
  // through the pane's normal image path, the rest is an ordinary launch request.
  useEffect(
    () =>
      onAttachment((attachment) => {
        const { files, draft, autoSend, profileId, newConversation, sessionId } = attachment;
        if (files?.length) {
          desktopAttachmentIdRef.current += 1;
          setDesktopAttachment({ files, id: desktopAttachmentIdRef.current });
        }
        launchAssistant({ draft, autoSend, profileId, newConversation, sessionId });
      }, 'assistant'),
    [launchAssistant],
  );

  useEffect(() => {
    setContextDismissed(false);
  }, [contextIdentity]);

  const effectiveContext = contextDismissed ? null : pageContext;
  const suggestions = useMemo(
    () =>
      getQuickActions(effectiveContext).map((action) => ({
        label: action.label,
        message: action.msg,
        icon: action.icon,
      })),
    [effectiveContext],
  );

  const getTurnEnvironment = useCallback((): ChatTurnEnvironment | undefined => {
    if (!effectiveContext) return undefined;
    const hint = getContextHint(effectiveContext);
    if (!hint) return undefined;
    const scopeId = pageActionScopeId();
    const actions = snapshotClientActions(scopeId);
    return {
      ambientContext: {
        version: 1,
        scope_id: scopeId,
        source: 'current-page',
        label: getContextLabel(effectiveContext),
        route: window.location.hash || '#/chat',
        hint,
      },
      clientActions: actions.length > 0 ? { scopeId, actions } : undefined,
    };
  }, [effectiveContext]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      setHistorySessions((await api.listSessions('active', false)).slice(0, 30));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const toggleHistory = useCallback(() => {
    setShowHistory((open) => {
      if (!open) void loadHistory();
      return !open;
    });
  }, [loadHistory]);

  if (!rendered) return null;

  const contextSlot = effectiveContext ? (
    <div className="flex items-center gap-1.5 px-4 py-2 border-b border-edge bg-surface-muted/60 flex-shrink-0">
      <span className="text-[10px] text-fg-faint">{t('agent.reference')}</span>
      <span className="inline-flex min-w-0 items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-primary-subtle text-primary-fg-strong border border-primary-edge">
        {React.createElement(getContextIcon(effectiveContext.type), { size: 12 })}
        <span className="truncate">{getContextLabel(effectiveContext)}</span>
        <button
          onClick={() => setContextDismissed(true)}
          className="ml-0.5 inline-flex min-h-7 min-w-7 items-center justify-center text-primary-400 transition-colors hover:text-primary-fg-strong"
          title={t('agent.removeReference')}
          aria-label={t('agent.removeReference')}
        >
          <X size={10} />
        </button>
      </span>
    </div>
  ) : contextDismissed && pageContext ? (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-edge bg-surface-muted/60 flex-shrink-0">
      <span className="text-[10px] text-fg-faint">{t('agent.referenceRemoved')}</span>
      <button
        onClick={() => setContextDismissed(false)}
        className="text-[10px] text-primary-fg hover:text-primary-fg-strong underline"
      >
        {t('common.restore')}
      </button>
    </div>
  ) : null;

  return (
    <OverlayPanel
      active={isOpen}
      onClose={close}
      ariaLabel={t('app.agentPanel')}
      panelRef={panelRef}
      motionState={closing ? 'exit' : 'enter'}
      onExited={handleExited}
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-surface-raised shadow-2xl md:inset-auto md:bottom-4 md:right-4 md:rounded-2xl md:border md:border-edge"
      style={{
        width: window.innerWidth >= 768 ? `${panelWidth}px` : undefined,
        height: window.innerWidth >= 768 ? `${panelHeight}px` : undefined,
        maxWidth: window.innerWidth >= 768 ? 'calc(100vw - 2rem)' : undefined,
        maxHeight: window.innerWidth >= 768 ? 'calc(100dvh - 2rem)' : undefined,
      }}
      extraContent={
        <div className="hidden md:block">
          <ResizeHandle
            orientation="vertical"
            value={panelWidth}
            min={400}
            max={Math.max(400, window.innerWidth - 32)}
            direction={-1}
            onChange={setPanelWidth}
            label={t('agent.resizeWidth')}
            className="absolute left-0 top-4 bottom-4 z-10"
          />
          <ResizeHandle
            orientation="horizontal"
            value={panelHeight}
            min={300}
            max={Math.max(300, window.innerHeight - 32)}
            direction={-1}
            onChange={setPanelHeight}
            label={t('agent.resizeHeight')}
            className="absolute top-0 left-4 right-4 z-10"
          />
        </div>
      }
    >
      <div className="px-4 py-3 bg-surface-raised border-b border-edge flex-shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Bot size={16} className="text-primary-fg" />
            <h3 className="truncate text-sm font-semibold text-fg">{t('agent.globalAssistant')}</h3>
            {currentSessionId && <Badge variant="secondary">{t('agent.conversation')}</Badge>}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={toggleHistory}
              className={`flex min-h-11 min-w-11 items-center justify-center rounded-md p-1.5 transition-colors md:min-h-0 md:min-w-0 ${
                showHistory
                  ? 'bg-primary-subtle text-primary-fg-strong'
                  : 'text-fg-faint hover:text-fg-secondary hover:bg-surface-muted'
              }`}
              title={t('agent.history')}
            >
              <Clock size={14} />
            </button>
            <button
              onClick={() => {
                setShowHistory(false);
                launchAssistant({ newConversation: true });
              }}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-md p-1.5 text-fg-faint transition-colors hover:bg-surface-muted hover:text-fg-secondary md:min-h-0 md:min-w-0"
              title={t('agent.newConversation')}
            >
              <Plus size={14} />
            </button>
            <button
              onClick={() => {
                setShowHistory(false);
                close();
                window.location.hash = currentSessionId ? `#/chat?session=${currentSessionId}` : '#/chat';
              }}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-md p-1.5 text-fg-faint transition-colors hover:bg-surface-muted hover:text-fg-secondary md:min-h-0 md:min-w-0"
              title={t('agent.openInChat')}
            >
              <Maximize2 size={14} />
            </button>
            <button
              onClick={close}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-md p-1.5 text-fg-faint transition-colors hover:bg-surface-muted hover:text-fg-secondary md:min-h-0 md:min-w-0"
              title={t('common.close')}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      </div>

      {showHistory && (
        <div className="max-h-64 overflow-y-auto border-b border-edge bg-surface-raised">
          {historyLoading && (
            <div className="flex justify-center py-4">
              <Spinner className="h-4 w-4 text-fg-faint" />
            </div>
          )}
          {!historyLoading && historySessions.length === 0 && (
            <p className="py-4 text-center text-xs text-fg-faint">{t('agent.noConversations')}</p>
          )}
          {historySessions.map((session) => (
            <button
              key={session.id}
              onClick={() => {
                launchAssistant({ sessionId: session.id });
                setShowHistory(false);
              }}
              className={`w-full border-b border-edge px-4 py-2 text-left transition-colors last:border-0 hover:bg-surface-sunken ${
                currentSessionId === session.id ? 'bg-primary-subtle' : ''
              }`}
            >
              <div className="truncate text-xs text-fg-secondary" title={session.title || t('common.untitled')}>
                {session.title || t('common.untitled')}
              </div>
              <div className="mt-0.5 text-[10px] text-fg-faint">{new Date(session.updated_at).toLocaleString()}</div>
            </button>
          ))}
        </div>
      )}

      <ConversationPane
        surface="overlay"
        visible={isOpen}
        viewportId="assistant-overlay"
        topSlot={contextSlot}
        suggestions={suggestions}
        launchRequest={launchRequest}
        onLaunchConsumed={clearLaunchRequest}
        onSessionChange={setCurrentSessionId}
        getTurnEnvironment={getTurnEnvironment}
        externalAttachment={desktopAttachment}
      />
    </OverlayPanel>
  );
}
