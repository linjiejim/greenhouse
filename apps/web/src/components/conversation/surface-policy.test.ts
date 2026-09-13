import { describe, expect, it } from 'vitest';
import { CONVERSATION_SURFACE_POLICIES } from './surface-policy';

describe('conversation surface policy', () => {
  it('lets the full surface publish page chrome and management affordances', () => {
    expect(CONVERSATION_SURFACE_POLICIES.full).toMatchObject({
      publishGlobalChatUi: true,
      showFeedback: true,
      showShare: true,
      showProfileManagement: true,
      allowTranslate: true,
      allowQuote: true,
    });
  });

  it('only removes peripheral affordances from the overlay', () => {
    expect(CONVERSATION_SURFACE_POLICIES.overlay).toEqual({
      compactMessages: true,
      publishGlobalChatUi: false,
      enrichPageContext: false,
      showFeedback: false,
      showShare: false,
      showProfileManagement: false,
      allowTranslate: false,
      allowQuote: false,
      // The overlay is a side panel about the page behind it; a personal
      // dashboard in its empty state would be noise, not a home page.
      showWorkbench: false,
    });
  });

  it('opens the full surface onto the workbench', () => {
    expect(CONVERSATION_SURFACE_POLICIES.full.showWorkbench).toBe(true);
  });
});
