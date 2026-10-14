/**
 * A reply's Markdown: GFM through `marked`, then DOMPurify, so nothing a model writes can run.
 * Links open in a new tab without the opener (the app's own `#/` addresses open in place); code
 * blocks get a language line and a copy button (conversation.md: 代码块不算卡片).
 */

import { memo, useMemo, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';
import { useNotify } from '../app/notify';
import { useT } from '../lib/i18n';

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const renderers = new Map<string, Marked>();

function rendererFor(copyLabel: string): Marked {
  const cached = renderers.get(copyLabel);
  if (cached) return cached;
  const renderer = createRenderer(copyLabel);
  renderers.set(copyLabel, renderer);
  return renderer;
}

function createRenderer(copyLabel: string) {
  return new Marked({
    gfm: true,
    breaks: true,
    renderer: {
      code({ text, lang }: Tokens.Code) {
        const language = (lang ?? '').split(/\s/)[0] ?? '';
        return `<div class="app-code"><div class="app-code-bar"><span>${escape(language)}</span><button type="button" class="app-code-copy" data-copy>${escape(copyLabel)}</button></div><pre><code>${escape(text)}</code></pre></div>`;
      },
    },
  });
}

let hooked = false;
function sanitize(html: string): string {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName !== 'A') return;
      // The app's own addresses (a doc an Agent linked, `#/knowledge/<id>`) open in place.
      if (node.getAttribute('href')?.startsWith('#/')) {
        node.removeAttribute('target');
        return;
      }
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    });
  }
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-copy'], FORBID_TAGS: ['style', 'form', 'input', 'textarea'] });
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const t = useT();
  const notify = useNotify();
  const copyLabel = t('message.copy');
  const html = useMemo(() => sanitize(rendererFor(copyLabel).parse(text, { async: false })), [text, copyLabel]);
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest('[data-copy]');
    if (!button) return;
    const code = button.closest('.app-code')?.querySelector('code')?.textContent ?? '';
    void navigator.clipboard
      ?.writeText(code)
      .then(() => notify(t('message.copied')))
      .catch(() => notify(t('message.copyFailed')));
  };
  return (
    <div
      className={className ? `app-markdown ${className}` : 'app-markdown'}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
