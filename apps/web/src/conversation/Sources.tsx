/**
 * 出处 (CONV-19): a reply's sources as one row of labels under it. A label opens the source in
 * the side drawer: what it is, where it lives, and 「就此追问」, which quotes it in the composer.
 */

import { useState } from 'react';
import { ExternalLink, Globe, MessageSquareQuote } from 'lucide-react';
import { Button, Overlay, OverlayActions } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Message } from '@greenhouse/contract';
import { useI18n } from '../lib/i18n';

type Source = Message['citations'][number];

const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Only web links open from here; anything else is not a link the browser should follow. */
const safeUrl = (url: string | undefined) => (url && /^https?:\/\//i.test(url) ? url : undefined);

export function Sources({ items, onAsk }: { items: Source[]; onAsk?: (source: Source) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<Source | null>(null);
  const url = safeUrl(open?.url);
  return (
    <div className="app-sources">
      <span className="app-sources-label">{t('sources.label')}</span>
      <ul className="app-sources-list">
        {items.map((source) => (
          <li key={`${source.kind}:${source.id}`}>
            <button
              type="button"
              className="app-source"
              title={source.title}
              aria-label={t('sources.open', { name: source.title })}
              onClick={() => setOpen(source)}
            >
              <Globe size={icon.sm} aria-hidden />
              <span>{source.url ? hostOf(source.url) : source.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <Overlay title={open.title} onClose={() => setOpen(null)}>
          <div className="app-source-detail">
            {url && <p className="app-mono app-muted">{url}</p>}
            <p>{t('sources.hint')}</p>
          </div>
          <OverlayActions>
            {url && (
              <Button className="app-actions-start" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>
                <ExternalLink size={icon.md} />
                {t('sources.visit')}
              </Button>
            )}
            {onAsk && (
              <Button
                kind="primary"
                onClick={() => {
                  onAsk(open);
                  setOpen(null);
                }}
              >
                <MessageSquareQuote size={icon.md} />
                {t('sources.ask')}
              </Button>
            )}
          </OverlayActions>
        </Overlay>
      )}
    </div>
  );
}
