export interface ConversationViewport {
  sessionId: string | null;
  visible: boolean;
}

/** A session is visible when at least one registered viewport currently shows it. */
export function collectVisibleSessionIds(viewports: Iterable<ConversationViewport>): Set<string> {
  const visibleSessions = new Set<string>();
  for (const viewport of viewports) {
    if (viewport.visible && viewport.sessionId) visibleSessions.add(viewport.sessionId);
  }
  return visibleSessions;
}
