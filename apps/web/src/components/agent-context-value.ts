import { createContext, useContext } from 'react';
import type { AssistantLaunchRequest, PageContext } from '@greenhouse/types/agent-context';
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

export const AgentContext = createContext<AgentContextValue | null>(null);

export function useAgentContext(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgentContext must be used within AgentProvider');
  return ctx;
}
