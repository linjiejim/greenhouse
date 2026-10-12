export type ConversationSurface = 'full' | 'overlay';

export interface ConversationSurfacePolicy {
  compactMessages: boolean;
  publishGlobalChatUi: boolean;
  enrichPageContext: boolean;
  showFeedback: boolean;
  showShare: boolean;
  showProfileManagement: boolean;
  allowTranslate: boolean;
  allowQuote: boolean;
  /**
   * Whether a new conversation opens onto the personal workbench. The full page
   * is the user's home; the overlay is a side panel about the page behind it,
   * where a dashboard would be noise.
   */
  showWorkbench: boolean;
  /**
   * With Agents on, a new conversation started here is a separate Agent chat on the Agents
   * engine (spec 20261011-agent-first-class §5a): the full page hands it over to `#/bots?c=`.
   * The overlay keeps the chat engine (D27): page context and client actions live there.
   */
  startsAgentChats: boolean;
}

/**
 * Surface policy only controls peripheral presentation and management affordances.
 * Sending, attachments, tools, confirmations, workflow UI, editing, regeneration,
 * streaming recovery and session persistence are intentionally not configurable.
 */
export const CONVERSATION_SURFACE_POLICIES: Record<ConversationSurface, ConversationSurfacePolicy> = {
  full: {
    compactMessages: false,
    publishGlobalChatUi: true,
    enrichPageContext: true,
    showFeedback: true,
    showShare: true,
    showProfileManagement: true,
    allowTranslate: true,
    allowQuote: true,
    showWorkbench: true,
    startsAgentChats: true,
  },
  overlay: {
    compactMessages: true,
    publishGlobalChatUi: false,
    enrichPageContext: false,
    showFeedback: false,
    showShare: false,
    showProfileManagement: false,
    allowTranslate: false,
    allowQuote: false,
    showWorkbench: false,
    startsAgentChats: false,
  },
};
