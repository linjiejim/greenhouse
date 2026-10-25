import { describe, expect, it } from 'vitest';
import { CONVERSATION_SURFACE_POLICIES } from './surface-policy';

describe('conversation surface policy', () => {
  it('lets the full surface publish page chrome and management affordances', () => {
    expect(CONVERSATION_SURFACE_POLICIES.full).toMatchObject({
      publishGlobalChatUi: true,
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
      showShare: false,
      showProfileManagement: false,
      allowTranslate: false,
      allowQuote: false,
    });
  });
});
