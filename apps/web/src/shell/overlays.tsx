/**
 * Drawers any page can open: one at a time (layout.md). Pages describe what to open; the shell
 * renders it, so "new Agent" works the same from the rail, ⌘K, a reply card or the Agents page.
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { CreateAgentInput } from '@greenhouse/contract';
import type { KnowledgeTarget, NewKind } from '../pages/knowledge/NewItemDialog';

export type OverlayRequest =
  | { type: 'new-agent'; prefill?: Partial<CreateAgentInput> & { template_key?: string } }
  | { type: 'new-room'; people?: string[] }
  | { type: 'new-skill' }
  /** 知识库 新建: a doc, a folder or files, in a folder or at the root of a space. */
  | { type: 'new-knowledge'; kind?: NewKind; target?: KnowledgeTarget }
  | { type: 'custom'; render: (close: () => void) => ReactNode };

export const OverlayContext = createContext<(request: OverlayRequest | null) => void>(() => undefined);

export const useOpenOverlay = () => useContext(OverlayContext);
