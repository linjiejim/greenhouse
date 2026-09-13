/**
 * AgentContext — global state for the context-aware Assistant overlay.
 *
 * Provides:
 * - Panel open/close state
 * - URL-driven page context (auto-detected from hash route)
 * - Page enrichment API (pages add data like titles after fetching)
 * - Generic launch intents shared by page integrations
 *
 * Context resolution flow:
 *   URL hash → resolveUrlContext() → base context (type + URL params)
 *   Page component → enrichPageContext() → merged context
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import type { AssistantLaunchRequest, PageContext } from '@greenhouse/types/agent-context';
import { pageContextKey } from '../lib/page-context-key';
import { parseExecutionSubPath } from '../lib/execution-route';
import { isSearchShortcut } from './search/shortcut';
import { useGlobalSearchStore } from '../stores/global-search-store';
export type { PageContext } from '@greenhouse/types/agent-context';

// Import and init all frontend context-providers (triggers registration)
import '../lib/context-providers';

export interface AgentContextValue {
  // Panel state
  isOpen: boolean;
  toggle: () => void;
  open: () => void;
  close: () => void;

  // Dynamic context — auto from URL + page enrichment
  pageContext: PageContext | null;
  /** Pages call this to add data not available from URL (e.g., title, email) */
  enrichPageContext: (data: Partial<PageContext> | null) => void;

  launchAssistant: (request?: Omit<AssistantLaunchRequest, 'id'>) => void;
  launchRequest: AssistantLaunchRequest | null;
  clearLaunchRequest: (id: number) => void;
}

// ─── URL → Context Resolution ────────────────────────────

/**
 * Parse the current hash route into a base PageContext.
 * This is the SINGLE place that maps URLs to context types.
 */
export function resolveUrlContext(hash: string): PageContext | null {
  const cleaned = hash.replace(/^#\/?/, '');
  const [path, query] = cleaned.split('?');
  const segments = path.split('/').filter(Boolean);
  const route = segments[0] || 'chat';
  const subPath = segments.slice(1).join('/');
  const params = new URLSearchParams(query || '');

  switch (route) {
    case 'chat':
      return {
        type: 'chat',
        sessionId: params.get('session') || undefined,
      };

    case 'projects':
      if (subPath) {
        const projectId = parseInt(subPath, 10);
        return isNaN(projectId) ? { type: 'project-list' } : { type: 'project-detail', projectId };
      }
      return { type: 'project-list' };

    case 'settings':
      // Evaluation remains a Settings sub-module.
      if (segments[1] === 'eval') {
        return {
          type: 'eval',
          runId: segments[2] === 'runs' && segments[3] ? segments[3] : undefined,
        };
      }
      if (subPath === 'feature-requests' || params.get('tab') === 'feature-requests') {
        return { type: 'feature-request-list' };
      }
      return null;

    case 'tables': {
      const baseId = Number(segments[1]);
      const itemId = Number(segments[3]);
      return {
        type: 'tables',
        baseId: Number.isInteger(baseId) && baseId > 0 ? baseId : undefined,
        tableId: segments[2] === 'table' && Number.isInteger(itemId) && itemId > 0 ? itemId : undefined,
        dashboardId: segments[2] === 'dashboard' && Number.isInteger(itemId) && itemId > 0 ? itemId : undefined,
      };
    }

    case 'executions': {
      const parsed = parseExecutionSubPath(segments.slice(1).join('/'));
      return {
        type: 'execution-center',
        runKind: parsed.kind ?? undefined,
        runId: parsed.runId ?? undefined,
      };
    }

    default:
      return null;
  }
}

// ─── Context ─────────────────────────────────────────────

const AgentContext = createContext<AgentContextValue | null>(null);

export function useAgentContext(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgentContext must be used within AgentProvider');
  return ctx;
}

// ─── Provider ────────────────────────────────────────────

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [launchRequest, setLaunchRequest] = useState<AssistantLaunchRequest | null>(null);
  const launchIdRef = React.useRef(0);

  // ── URL-driven context ──
  const [hash, setHash] = useState(window.location.hash || '#/chat');
  useEffect(() => {
    const handler = () => setHash(window.location.hash || '#/chat');
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const urlContext = useMemo(() => resolveUrlContext(hash), [hash]);

  // Page enrichment — pages add data like titles after fetch
  const [enrichment, setEnrichment] = useState<Partial<PageContext>>({});

  // Reset enrichment when URL context type/key changes
  const contextKey = pageContextKey(urlContext);
  useEffect(() => {
    setEnrichment({});
  }, [contextKey]);

  // Merged context = URL base + enrichment
  const pageContext = useMemo<PageContext | null>(() => {
    if (!urlContext) return null;
    const hasEnrichment = Object.keys(enrichment).length > 0;
    return hasEnrichment ? ({ ...urlContext, ...enrichment } as PageContext) : urlContext;
  }, [urlContext, enrichment]);

  const enrichPageContext = useCallback((data: Partial<PageContext> | null) => {
    setEnrichment(data ?? {});
  }, []);

  // ── Panel controls ──
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const launchAssistant = useCallback((request: Omit<AssistantLaunchRequest, 'id'> = {}) => {
    setIsOpen(true);
    launchIdRef.current += 1;
    setLaunchRequest({ ...request, id: launchIdRef.current });
  }, []);
  const clearLaunchRequest = useCallback((id: number) => {
    setLaunchRequest((current) => (current?.id === id ? null : current));
  }, []);

  // ── Global keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      // Cmd+K / Ctrl+K: toggle Assistant overlay
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
        return;
      }

      // Cmd+P / Ctrl+P: toggle global search. Registered here with the other
      // global shortcuts rather than inside the palette, so it works before the
      // palette has ever been mounted.
      if (isSearchShortcut(e)) {
        e.preventDefault();
        useGlobalSearchStore.getState().toggle();
        return;
      }

      // Cmd+Escape / Ctrl+Escape: close Assistant overlay (or any top-level panel)
      if ((e.metaKey || e.ctrlKey) && e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
        return;
      }

      // Escape (no modifier): close Assistant overlay if open
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !isInput) {
        if (isOpen) {
          e.preventDefault();
          setIsOpen(false);
          return;
        }
      }

      // Cmd+N / Ctrl+N: new chat session (always intercept to prevent browser new window)
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        window.location.hash = `#/chat?new=${Date.now()}`;
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen]);

  const value: AgentContextValue = {
    isOpen,
    toggle,
    open,
    close,
    pageContext,
    enrichPageContext,
    launchAssistant,
    launchRequest,
    clearLaunchRequest,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
