/**
 * A Mermaid diagram, rendered by Mermaid itself in strict mode (its own sanitizer, no clicks
 * or scripts). Loaded only when a reply has one. A diagram Mermaid rejects stays its source.
 */

import { useEffect, useId, useState } from 'react';
import { Skeleton } from '@greenhouse/ui/kit';
import { useI18n } from '../../lib/i18n';
import { Markdown } from '../Markdown';

const dark = () =>
  document.documentElement.dataset.theme === 'dark' ||
  (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);

export default function MermaidView({ code }: { code: string }) {
  const { t } = useI18n();
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark() ? 'dark' : 'neutral' });
        const result = await mermaid.render(`mermaid-${id}`, code);
        if (live) setSvg(result.svg);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [code, id]);

  if (failed) return <Markdown text={'```mermaid\n' + code + '\n```'} />;
  return (
    <>
      {svg ? (
        <div
          className="app-mermaid"
          role="region"
          tabIndex={0}
          aria-label={t('rich.diagram')}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="app-mermaid" role="status" aria-label={t('common.loading')}>
          <Skeleton lines={6} />
        </div>
      )}
    </>
  );
}
