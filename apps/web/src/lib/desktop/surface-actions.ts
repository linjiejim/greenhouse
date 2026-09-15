/** Cross-window helpers shared by Desktop satellite surfaces. */

import { isDesktop, onDesktopEvent } from './bridge';

const KNOWLEDGE_SEARCH_EVENT = 'greenhouse://knowledge-search';

export interface KnowledgeSearchRequest {
  query: string;
}

async function emit<T>(event: string, payload: T): Promise<void> {
  if (!isDesktop()) return;
  const { emit: tauriEmit } = await import('@tauri-apps/api/event');
  await tauriEmit(event, payload);
}

export function requestKnowledgeSearch(query: string): Promise<void> {
  return emit<KnowledgeSearchRequest>(KNOWLEDGE_SEARCH_EVENT, { query });
}

export function onKnowledgeSearch(listener: (request: KnowledgeSearchRequest) => void): Promise<() => void> {
  return onDesktopEvent(KNOWLEDGE_SEARCH_EVENT, listener);
}

export function composeSelectionMessage(selection: string, instruction: string): string {
  const content = selection.trim();
  const directive = instruction.trim();
  if (!directive) return content;
  return `选中内容：\n${content}\n\n用户指示：\n${directive}`;
}
