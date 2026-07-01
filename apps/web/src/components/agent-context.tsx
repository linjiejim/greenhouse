/**
 * AgentContext — global state for the Global Agent panel.
 *
 * Provides:
 * - Panel open/close state
 * - URL-driven page context (auto-detected from hash route)
 * - Page enrichment API (pages add data like titles after fetching)
 * - beforeunload protection delegated to SessionManager
 *
 * Context resolution flow:
 *   URL hash → resolveUrlContext() → base context (type + URL params)
 *   Page component → enrichPageContext() → merged context
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';

// Import and init all frontend context-providers (triggers registration)
import '../lib/context-providers';
import { resolveExtraUrlContext } from '../lib/context-resolvers';

// ─── Types ───────────────────────────────────────────────

export interface PageContext {
  // Core page types plus `(string & {})` so a downstream fork can contribute its
  // own page types (e.g. 'crm') via registerUrlContextResolver without editing
  // this union. The `(string & {})` member keeps literal autocomplete for the
  // core types while accepting any string. See lib/context-resolvers.ts.
  type: 'chat' | 'history' | 'feature-request-list' | 'project-list' | 'project-detail' | (string & {});
  slug?: string;
  title?: string;
  category?: string;
  sessionId?: string;
  lastAssistantMessageId?: string;
  runId?: string;
  totalPending?: number;
  projectId?: number;
  projectTitle?: string;
  /** Fork route sub-path segment (e.g. a private module id). Set by fork resolvers. */
  module?: string;
}

export interface AgentContextValue {
  // Panel state
  isOpen: boolean;
  toggle: () => void;
  open: (initialPrompt?: string) => void;
  close: () => void;

  // Dynamic context — auto from URL + page enrichment
  pageContext: PageContext | null;
  /** @deprecated Use enrichPageContext() instead — base context is auto-derived from URL */
  setPageContext: (ctx: PageContext | null) => void;
  /** Pages call this to add data not available from URL (e.g., title, email) */
  enrichPageContext: (data: Partial<PageContext> | null) => void;

  // Convenience triggers
  openWithDraft: (draft: string) => void;
  /** Open panel with a specific profile and optional draft prompt */
  openWithProfile: (profileId: string, draft?: string) => void;

  // Pending initial prompt (set by open()) — auto-executed
  pendingPrompt: string | null;
  clearPendingPrompt: () => void;

  // Draft prompt (set in input field, user must confirm)
  draftPrompt: string | null;
  clearDraftPrompt: () => void;

  // Restore session (load an existing agent session)
  pendingRestoreSessionId: string | null;
  clearPendingRestore: () => void;

  // Profile override (set by openWithProfile) — used by agent panel
  pendingProfile: string | null;
  clearPendingProfile: () => void;
}

// ─── URL → Context Resolution ────────────────────────────

/**
 * Parse the current hash route into a base PageContext.
 * Core routes are handled by the switch below; any other route falls through to
 * the fork resolver registry (lib/context-resolvers.ts) — empty upstream.
 * Exported for unit testing.
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

    case 'history':
      return { type: 'history' };

    case 'projects':
      if (subPath) {
        const projectId = parseInt(subPath, 10);
        return isNaN(projectId) ? { type: 'project-list' } : { type: 'project-detail', projectId };
      }
      return { type: 'project-list' };

    case 'settings':
      if (subPath === 'feature-requests' || params.get('tab') === 'feature-requests') {
        return { type: 'feature-request-list' };
      }
      return null;

    default:
      // Fork-contributed routes (empty upstream) — see lib/context-resolvers.ts.
      return resolveExtraUrlContext(route, subPath, params);
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
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

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
  const contextKey = urlContext
    ? `${urlContext.type}:${(urlContext as any).slug || ''}:${(urlContext as any).projectId || ''}:${(urlContext as any).itemId || ''}:${(urlContext as any).module || ''}:${(urlContext as any).sessionId || ''}`
    : '';
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

  // Legacy setPageContext — still works, overwrites everything
  // Kept for backward compatibility during migration
  const [legacyOverride, setLegacyOverride] = useState<PageContext | null>(null);
  const setPageContext = useCallback((ctx: PageContext | null) => {
    setLegacyOverride(ctx);
  }, []);

  // Final context: legacy override takes precedence if set
  const effectivePageContext = legacyOverride ?? pageContext;

  // ── Panel controls ──
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);
  const open = useCallback((initialPrompt?: string) => {
    setIsOpen(true);
    if (initialPrompt) setPendingPrompt(initialPrompt);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);
  const clearPendingPrompt = useCallback(() => setPendingPrompt(null), []);

  // Draft prompt — shown in input field for user to confirm (not auto-sent)
  const [draftPrompt, setDraftPrompt] = useState<string | null>(null);
  const clearDraftPrompt = useCallback(() => setDraftPrompt(null), []);

  // Pending restore session ID
  const [pendingRestoreSessionId, setPendingRestoreSessionId] = useState<string | null>(null);
  const clearPendingRestore = useCallback(() => setPendingRestoreSessionId(null), []);

  // ── Convenience triggers ──
  const openWithDraft = useCallback((draft: string) => {
    setIsOpen(true);
    setDraftPrompt(draft);
  }, []);

  const [pendingProfile, setPendingProfile] = useState<string | null>(null);
  const clearPendingProfile = useCallback(() => setPendingProfile(null), []);

  const openWithProfile = useCallback((profileId: string, draft?: string) => {
    setIsOpen(true);
    setPendingProfile(profileId);
    if (draft) setDraftPrompt(draft);
  }, []);

  // ── Global keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      // Cmd+K / Ctrl+K: toggle Agent panel
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
        return;
      }

      // Cmd+Escape / Ctrl+Escape: close Agent panel (or any top-level panel)
      if ((e.metaKey || e.ctrlKey) && e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
        return;
      }

      // Escape (no modifier): close Agent panel if open
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
    pageContext: effectivePageContext,
    setPageContext,
    enrichPageContext,
    openWithDraft,
    openWithProfile,
    pendingPrompt,
    clearPendingPrompt,
    draftPrompt,
    clearDraftPrompt,
    pendingRestoreSessionId,
    clearPendingRestore,
    pendingProfile,
    clearPendingProfile,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
