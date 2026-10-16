import { useMemo, useState } from 'react';
import createDOMPurify from 'dompurify';
import { Marked } from 'marked';
import { Button } from '@greenhouse/ui/kit';
import { useT } from '../lib/i18n';

const parser = new Marked({ gfm: true, breaks: true });
let purifier: ReturnType<typeof createDOMPurify> | undefined;

/** A small text-only preview: no remote pictures, links, HTML controls or custom styling. */
export function previewHtml(text: string): string {
  purifier ??= createDOMPurify(window);
  return purifier.sanitize(parser.parse(text, { async: false }), {
    ALLOWED_TAGS: [
      'p',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'ul',
      'ol',
      'li',
      'strong',
      'em',
      'del',
      'pre',
      'code',
      'blockquote',
      'br',
    ],
    ALLOWED_ATTR: [],
  });
}

export function MarkdownPreview({ text }: { text: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const html = useMemo(() => previewHtml(text), [text]);
  return (
    <div className="app-markdown-preview">
      <div className={`app-markdown${expanded ? '' : ' is-clamped'}`} dangerouslySetInnerHTML={{ __html: html }} />
      <Button size="sm" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        {t(expanded ? 'request.collapsePreview' : 'request.expandPreview')}
      </Button>
    </div>
  );
}
