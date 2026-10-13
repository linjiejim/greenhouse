/**
 * Drawers any page can open: one at a time (layout.md). Pages describe what to open; the shell
 * renders it, so "new Agent" works the same from the rail, ⌘K, a reply card or the Agents page.
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { CreateAgentInput } from '@greenhouse/contract';

export type OverlayRequest =
  | { type: 'new-agent'; prefill?: Partial<CreateAgentInput> & { template_key?: string } }
  | { type: 'new-room'; people?: string[] }
  | { type: 'custom'; render: (close: () => void) => ReactNode };

export const OverlayContext = createContext<(request: OverlayRequest | null) => void>(() => undefined);

export const useOpenOverlay = () => useContext(OverlayContext);
