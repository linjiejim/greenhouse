import { readFileSync } from 'node:fs';
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
    });
  });

  it('keeps the workbench cards out of Chat on every surface — Home owns them (v1.5)', () => {
    for (const policy of Object.values(CONVERSATION_SURFACE_POLICIES)) {
      expect(Object.keys(policy)).not.toContain('showWorkbench');
    }
    const pane = readFileSync(new URL('./conversation-pane.tsx', import.meta.url), 'utf8');
    expect(pane).not.toContain('WorkbenchPanel');
  });
});
