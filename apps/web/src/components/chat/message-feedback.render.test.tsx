import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { MessageFeedback } from './message-feedback';

describe('MessageFeedback progressive disclosure', () => {
  it('renders only thumbs in the resting state', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(MessageFeedback, {
          messageId: '',
          sessionId: 'session-1',
          inline: true,
        }),
      }),
    );

    expect(html).toContain('aria-label="Good response"');
    expect(html).toContain('aria-label="Bad response"');
    expect(html).not.toContain('Rate this response');
    expect(html).not.toContain('Add a note');
    expect(html).not.toContain('star');
  });

  it('adds an icon-only rating entry when hosted by the TopBar', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(MessageFeedback, {
          messageId: '',
          sessionId: 'session-1',
          toolbar: true,
        }),
      }),
    );

    expect(html).not.toContain('aria-label="Good response"');
    expect(html).not.toContain('aria-label="Bad response"');
    expect(html).toContain('aria-label="Rate this response"');
    expect(html).not.toContain('rounded-lg border border-edge bg-surface-muted');
  });
});
