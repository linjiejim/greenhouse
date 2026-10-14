/**
 * One mail of an Agent's mailbox (AGNT-30), opened from its card in the conversation or from the
 * Agent's Mailbox tab. Mail is written by strangers: its HTML goes through DOMPurify (a purifier
 * of its own, so its hooks never touch the replies' Markdown) with no styles, scripts, forms or
 * frames, links open outside, and images from other hosts stay unloaded until asked; images the
 * mail carries itself (`cid:`) show through their signed file links. Attachments open the same way.
 */

import { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { Paperclip } from 'lucide-react';
import { Banner, Button, ErrorBox, Overlay, Skeleton, StatusBadge } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { MailDetail } from '@greenhouse/contract';
import { useNotify } from '../app/notify';
import { useMe } from '../app/session';
import { useMailDetail, useReleaseMail } from '../data/mail';
import type { MessageKey } from '../i18n/zh';
import { errorText } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { fullTime } from '../lib/time';

const FORBID_TAGS = [
  'style',
  'link',
  'meta',
  'base',
  'title',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'video',
  'audio',
  'source',
  'track',
  'svg',
  'math',
  'template',
];
const FORBID_ATTR = ['style', 'class', 'id', 'srcset', 'background', 'poster', 'action', 'formaction', 'ping'];

let purifier: ReturnType<typeof DOMPurify> | null = null;

/** A link in a mail may stay only to the web or to mail. */
export const linkAllowed = (href: string) => /^(https?:|mailto:)/i.test(href.trim());

/**
 * What an image's address becomes: the mail's own (`cid:`) through its signed file link, a remote
 * one only when asked (`blocked` otherwise), a small inline picture as it is, anything else none.
 */
export function imageSource(
  src: string,
  options: { remote: boolean; inline: ReadonlyMap<string, string> },
): { src: string | null; blocked: boolean } {
  const value = src.trim();
  if (/^cid:/i.test(value)) {
    return { src: options.inline.get(value.slice(4).replace(/^<|>$/g, '')) ?? null, blocked: false };
  }
  if (/^https?:/i.test(value)) return options.remote ? { src: value, blocked: false } : { src: null, blocked: true };
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(value)) return { src: value, blocked: false };
  return { src: null, blocked: false };
}

/**
 * The mail's HTML, safe to show: remote images left out unless `remote`, inline ones pointed at
 * their attachments. Also how many remote images were held back.
 */
export function sanitizeMail(
  html: string,
  options: { remote: boolean; inline: ReadonlyMap<string, string> },
): { html: string; blocked: number } {
  purifier ??= DOMPurify(window);
  let blocked = 0;
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      if (linkAllowed(node.getAttribute('href') ?? '')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer nofollow');
      } else node.removeAttribute('href');
    }
    if (node.tagName === 'IMG') {
      const image = imageSource(node.getAttribute('src') ?? '', options);
      if (image.blocked) blocked += 1;
      if (image.src) node.setAttribute('src', image.src);
      else node.removeAttribute('src');
    }
  });
  try {
    const clean = purifier.sanitize(html, { FORBID_TAGS, FORBID_ATTR, ALLOW_DATA_ATTR: false });
    return { html: clean, blocked };
  } finally {
    purifier.removeAllHooks();
  }
}

const REASON: Record<NonNullable<MailDetail['screen_reason']>, MessageKey> = {
  sender: 'mail.reason.sender',
  unverified: 'mail.reason.unverified',
  public_agent: 'mail.reason.public_agent',
  archived: 'mail.reason.archived',
};

const who = (entry: { address: string; name: string | null }) =>
  entry.name ? `${entry.name} <${entry.address}>` : entry.address;

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Body({ mail }: { mail: MailDetail }) {
  const { t } = useI18n();
  const [remote, setRemote] = useState(false);
  const inline = useMemo(
    () =>
      new Map(
        mail.attachments
          .filter((part) => part.content_id && part.url)
          .map((part) => [part.content_id!, part.url!] as const),
      ),
    [mail.attachments],
  );
  const shown = useMemo(
    () => (mail.html ? sanitizeMail(mail.html, { remote, inline }) : null),
    [mail.html, remote, inline],
  );
  return (
    <>
      {shown && shown.blocked > 0 && !remote && (
        <Banner
          tone="info"
          action={
            <Button size="sm" onClick={() => setRemote(true)}>
              {t('mail.showImages')}
            </Button>
          }
        >
          {t('mail.imagesBlocked')}
        </Banner>
      )}
      {shown ? (
        <div className="app-mail-html" dangerouslySetInnerHTML={{ __html: shown.html }} />
      ) : (
        <pre className="app-mail-text">{mail.text}</pre>
      )}
    </>
  );
}

export function MailDrawer({ agentId, mailId, onClose }: { agentId: string; mailId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const detail = useMailDetail(agentId, mailId);
  const release = useReleaseMail(agentId);
  const mail = detail.data;
  return (
    <Overlay title={mail ? mail.subject || t('mail.noSubject') : t('mail.open')} onClose={onClose} wide>
      {detail.isPending && <Skeleton lines={6} />}
      {detail.isError && <ErrorBox onRetry={() => void detail.refetch()}>{errorText(detail.error, t)}</ErrorBox>}
      {mail && (
        <article className="app-mail" aria-label={mail.subject || t('mail.noSubject')}>
          {mail.status === 'screened' && (
            <Banner
              tone="warning"
              action={
                <Button
                  size="sm"
                  kind="primary"
                  loading={release.isPending}
                  onClick={() =>
                    void release
                      .mutateAsync(mail.id)
                      .then((done) => {
                        notify(t('mail.released', { sender: done.sender, count: done.delivered }));
                        return detail.refetch();
                      })
                      .catch((caught: unknown) => notify(errorText(caught, t)))
                  }
                >
                  {t('mail.release')}
                </Button>
              }
            >
              {t('mail.screenedBanner', { reason: mail.screen_reason ? t(REASON[mail.screen_reason]) : '' })}
            </Banner>
          )}
          <dl className="app-mail-head">
            <dt>{t('mail.from')}</dt>
            <dd>
              {who(mail.from)}{' '}
              {mail.direction === 'in' && (
                <StatusBadge
                  status={mail.verified ? t('mail.verified') : t('mail.unverified')}
                  tone={mail.verified ? 'success' : 'neutral'}
                />
              )}
            </dd>
            <dt>{t('mail.to')}</dt>
            <dd>{mail.to.map(who).join(', ')}</dd>
            {mail.cc.length > 0 && (
              <>
                <dt>{t('mail.cc')}</dt>
                <dd>{mail.cc.map(who).join(', ')}</dd>
              </>
            )}
            <dt>{t('mail.date')}</dt>
            <dd>{fullTime(mail.at, { locale, timeZone: me.timezone })}</dd>
          </dl>
          <Body mail={mail} />
          {mail.attachments.length > 0 && (
            <section className="app-section" aria-label={t('mail.attachments')}>
              <h3 className="app-section-title">{t('mail.attachments')}</h3>
              <ul className="app-list">
                {mail.attachments.map((part, index) => (
                  <li key={index} className="app-list-row is-static">
                    <Paperclip size={icon.md} className="app-file-icon" aria-hidden />
                    <span className="app-list-main">
                      {part.url ? (
                        <a className="app-list-title" href={part.url} target="_blank" rel="noopener noreferrer">
                          {part.name}
                        </a>
                      ) : (
                        <span className="app-list-title">{part.name}</span>
                      )}
                      <span className="app-list-meta">
                        {size(part.size_bytes)}
                        {part.skipped ? ` · ${t(`mail.skipped.${part.skipped}`)}` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      )}
    </Overlay>
  );
}
