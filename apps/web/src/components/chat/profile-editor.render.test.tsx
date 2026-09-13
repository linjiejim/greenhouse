import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../lib/i18n';
import { ProfileEditorDrawer } from './profile-editor';

describe('ProfileEditorDrawer', () => {
  it('uses the wide split workspace with an independent tools column', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ProfileEditorDrawer, {
          open: true,
          onClose: vi.fn(),
          profile: null,
          availableTools: [
            {
              id: 'knowledge_query',
              name: 'Knowledge Query',
              brief: 'Search and read team or personal knowledge.',
              category: 'team',
              is_global: true,
              icon: 'BookOpen',
              surface: { proxy: 'read', mcp: 'knowledge' },
            },
            {
              id: 'knowledge_mutation',
              name: 'Knowledge Mutation',
              brief: 'Create and update knowledge with confirmation.',
              category: 'team',
              is_global: false,
              icon: 'Pencil',
              surface: { proxy: 'write', mcp: 'knowledge' },
            },
            {
              id: 'ask_user',
              name: 'Ask User',
              brief: 'Ask the user clarifying questions.',
              category: 'core',
              is_global: true,
              builtin: true,
              icon: 'MessageCircleQuestion',
            },
          ],
          isSuper: false,
          onSave: vi.fn(),
        }),
      }),
    );

    expect(html).toContain('aria-label="Create Agent"');
    expect(html).toContain('sm:w-[90vw]');
    expect(html).toContain('lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]');
    expect(html).toContain('Choose only the tools this Agent needs');
    // Built-ins are not offered as choices — every Agent has them, so a
    // checkbox would be asking a question whose answer changes nothing.
    expect(html).not.toContain('Ask the user clarifying questions.');
    expect(html).toContain('Search and read team or personal knowledge.');
    expect(html).toContain('Create and update knowledge with confirmation.');
    expect(html).toContain('Read');
    expect(html).toContain('Write');
    expect(html).toContain('Confirm');
    expect(html).toContain('Selected only');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Create Agent<\/button>/);
    expect(html).toContain('lg:overflow-y-auto');
    expect(html).toContain('min-h-0 flex-1 overflow-y-auto');
  });
});
