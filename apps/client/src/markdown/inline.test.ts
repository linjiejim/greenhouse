/**
 * The inline Markdown renderer, which a member's chat bubble uses too (src/chat/messages.tsx
 * `UserMessage`). React comes from the web app (the mobile app is outside the workspace, see
 * src/startup/startup.test.ts); the native and app modules it reaches are stubbed. Keep this as
 * .test.ts: the isolated mobile typecheck excludes root unit tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { askUserAnswer } from '../chat/parts';

const test = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module');
  const { resolve } = await import('node:path');
  const require = createRequire(resolve('package.json'));
  const React = require('react') as typeof import('react');
  return {
    React,
    jsx: require('react/jsx-runtime'),
    jsxDev: require('react/jsx-dev-runtime'),
    render: require('react-dom/server').renderToStaticMarkup as (node: unknown) => string,
  };
});

vi.mock('react', () => ({ ...test.React, default: test.React }));
vi.mock('react/jsx-runtime', () => test.jsx);
vi.mock('react/jsx-dev-runtime', () => test.jsxDev);
vi.mock('react-native', () => ({
  Text: ({ children, style }: { children?: unknown; style?: { mark?: string } }) =>
    test.React.createElement(style?.mark ?? 'span', null, children as never),
}));
vi.mock('../theme', () => ({
  makeStyles: () => () => ({ bold: { mark: 'b' }, medium: { mark: 'b' }, italic: { mark: 'i' }, strike: { mark: 's' }, inlineCode: { mark: 'code' } }),
  useTheme: () => ({ colors: {} }),
  mono: 'mono',
  typo: { subheadline: {} },
  weight: {},
}));
vi.mock('../lib/i18n', () => ({ useT: () => (key: string) => key }));
vi.mock('../ui/dialogs', () => ({ alertError: () => undefined }));
vi.mock('../shell/open-object', () => ({ useOpenHref: () => () => true }));
vi.mock('./link-chip', () => ({ chipFor: () => null, LinkChip: () => null }));

const { Inline } = await import('./inline');
const html = (text: string) => test.render(test.React.createElement(Inline, { text }));

describe('inline Markdown', () => {
  it('shows an ask_user answer’s labels bold, without the ** markers', () => {
    const ask = { title: 'Q', questions: [{ id: 'a', label: 'Size', type: 'single_choice' as const, options: [{ value: 'l', label: 'Large' }] }] };
    const out = html(askUserAnswer(ask, { a: 'l' }));
    expect(out).toContain('<b><span>1. Size</span></b>');
    expect(out).not.toContain('**');
  });

  it('takes a link destination in <…> or with balanced parentheses whole', () => {
    const url = 'https://developer.apple.com/documentation/swiftui/view/presentationdetents(_:)';
    expect(html(`[Docs](<${url}>)`)).toBe('<span><span>Docs</span></span>');
    expect(html(`[Docs](${url})`)).toBe('<span><span>Docs</span></span>');
  });

  it('keeps balanced parentheses in a bare URL but not a closing one around it', () => {
    const url = 'https://developer.apple.com/documentation/swiftui/view/presentationdetents(_:)';
    expect(html(`see ${url} ok`)).toBe(`<span>see </span><span>${url}</span><span> ok</span>`);
    expect(html('(https://example.com/a)')).toBe('<span>(</span><span>https://example.com/a</span><span>)</span>');
  });

  it('leaves arithmetic and snake_case alone', () => {
    expect(html('2 * 3 * 4 and foo_bar_baz')).toBe('<span>2 * 3 * 4 and foo_bar_baz</span>');
  });
});
