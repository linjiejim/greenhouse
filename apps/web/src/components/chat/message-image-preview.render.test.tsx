import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { MessageBubble } from './message';

vi.mock('./user-message-content', () => ({
  UserMessageContent: ({ content }: { content: string }) => createElement('p', null, content),
}));

describe('user message image preview', () => {
  it('opens images through an in-app preview trigger instead of raw-image navigation', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(MessageBubble, {
          role: 'user',
          content: 'Photo',
          images: [{ id: 'image-1', url: '/uploads/example.png' }],
        }),
      }),
    );

    expect(html).toContain('aria-label="View attachment 1 / 1"');
    expect(html).toContain('<button');
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain('href="/uploads/example.png"');
  });
});
