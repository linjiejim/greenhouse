/**
 * Agent panel helper functions — registry-based context resolution.
 *
 * All display logic (labels, placeholders, quick actions) and context hints
 * are delegated to the context-providers registry. No per-type switch statements.
 */

import type { PageContext } from '../agent-context';
import type { LucideIcon } from '../../lib/icons';
import { Search, BarChart3 } from '../../lib/icons';
import { getContextProvider } from '../../lib/context-registry';

// ─── Defaults ────────────────────────────────────────────

const DEFAULT_LABEL = 'Global assistant';
const DEFAULT_EMPTY_MSG = 'How can I help?';
const DEFAULT_PLACEHOLDER = 'Ask a question...';

export interface QuickAction {
  icon: LucideIcon;
  label: string;
  msg: string;
}

const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  { icon: Search, label: 'Search knowledge base', msg: 'Search the knowledge base for: ' },
  { icon: BarChart3, label: 'Overview', msg: 'Give me an overview of what you can help with.' },
];

// ─── Registry-delegated helpers ──────────────────────────

export function getContextLabel(ctx: PageContext | null): string {
  if (!ctx) return DEFAULT_LABEL;
  const provider = getContextProvider(ctx.type as any);
  if (provider) return provider.label(ctx as any);
  return DEFAULT_LABEL;
}

export function getEmptyStateMessage(ctx: PageContext | null): string {
  if (!ctx) return DEFAULT_EMPTY_MSG;
  const provider = getContextProvider(ctx.type as any);
  if (provider) {
    const msg = provider.emptyMessage(ctx as any);
    return msg || DEFAULT_EMPTY_MSG;
  }
  return DEFAULT_EMPTY_MSG;
}

export function getPlaceholder(ctx: PageContext | null): string {
  if (!ctx) return DEFAULT_PLACEHOLDER;
  const provider = getContextProvider(ctx.type as any);
  if (provider) {
    const ph = provider.placeholder(ctx as any);
    return ph || DEFAULT_PLACEHOLDER;
  }
  return DEFAULT_PLACEHOLDER;
}

export function getQuickActions(ctx: PageContext | null): QuickAction[] {
  if (!ctx) return DEFAULT_QUICK_ACTIONS;
  const provider = getContextProvider(ctx.type as any);
  if (provider) {
    const actions = provider.quickActions(ctx as any);
    if (actions.length > 0) {
      return actions.map((qa) => ({ ...qa, icon: qa.icon as LucideIcon }));
    }
  }
  return DEFAULT_QUICK_ACTIONS;
}

/**
 * Generate a context hint string to send to the backend.
 * This replaces the old per-type backend context-provider registry.
 */
export function getContextHint(ctx: PageContext | null): string | undefined {
  if (!ctx) return undefined;
  const provider = getContextProvider(ctx.type as any);
  if (provider) return provider.contextHint(ctx as any);
  return undefined;
}

// Re-export safeParse for backward compat with agent-panel
export { safeParse } from '../../lib/utils';
