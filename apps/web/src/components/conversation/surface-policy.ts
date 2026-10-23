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
}

/**
 * Surface policy only controls peripheral presentation and management affordances.
 * Sending, attachments, tools, confirmations, editing, regeneration,
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
  },
};
