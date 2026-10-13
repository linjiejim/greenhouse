/**
 * One message (conversation.md): the member's own words in a light bubble on the right; an
 * Agent's reply without a bubble in bodyLg, in the order conclusion → result cards → decisions
 * → process. Events are one quiet line. Actions show on hover (long press on touch).
 */

import { memo, useState, type ReactNode } from 'react';
import { CircleAlert, Copy, Quote, Split, ThumbsDown, ThumbsUp, Volume2, Wrench } from 'lucide-react';
import { ChatCard, IconButton } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Agent, MemberSummary, Message, NeedsYou } from '@greenhouse/contract';
import { useNotify } from '../app/notify';
import { liveText, useStream, type LiveStep } from '../data/streams';
import { cx } from '../lib/cx';
import { useI18n } from '../lib/i18n';
import { fullTime, relativeTime } from '../lib/time';
import { AgentAvatar } from '../shell/AgentAvatar';
import { MemberAvatar } from '../shell/MemberAvatar';
import { Markdown } from './Markdown';
import { RequestCard } from './RequestCard';

export interface Author {
  name: string;
  agent?: Pick<Agent, 'id' | 'avatar' | 'template_key'>;
  member?: Pick<MemberSummary, 'avatar_url'>;
}

type Step = { tool: string; summary: string; status: 'running' | 'done' | 'failed'; duration_ms?: number };

/** All tool calls of a reply folded into one process card; failed ones open by default. */
function ProcessCard({ steps }: { steps: Step[] }) {
  const { t } = useI18n();
  if (!steps.length) return null;
  const running = steps.some((step) => step.status === 'running');
  const failed = steps.some((step) => step.status === 'failed');
  const title = steps.length === 1 ? steps[0]!.summary : `${steps[0]!.summary}…`;
  return (
    <ChatCard
      expandable
      defaultOpen={failed}
      icon={<Wrench size={icon.md} />}
      title={title}
      meta={steps.length > 1 ? t('message.steps', { count: steps.length }) : undefined}
      status={running ? t('status.running') : failed ? t('status.failed') : undefined}
      tone={running ? 'info' : failed ? 'danger' : undefined}
    >
      <ol className="app-steps">
        {steps.map((step, index) => (
          <li key={index} className={cx('app-step', `is-${step.status}`)}>
            <span className="app-step-dot" aria-hidden />
            <span className="app-step-summary">{step.summary}</span>
            {step.duration_ms !== undefined && (
              <span className="app-step-time">{(step.duration_ms / 1000).toFixed(1)}s</span>
            )}
          </li>
        ))}
      </ol>
    </ChatCard>
  );
}

function readAloud(text: string, locale: 'zh' | 'en', onEnd: () => void): boolean {
  const synth = window.speechSynthesis;
  if (!synth) return false;
  const utterance = new SpeechSynthesisUtterance(
    // Read the prose only: no code blocks or tables.
    text.replace(/```[\s\S]*?```/g, '').replace(/^\|.*\|$/gm, ''),
  );
  utterance.lang = locale === 'zh' ? 'zh-CN' : 'en-US';
  utterance.onend = onEnd;
  utterance.onerror = onEnd;
  synth.cancel();
  synth.speak(utterance);
  return true;
}

export const MessageView = memo(function MessageView({
  message,
  author,
  showAuthor,
  mine,
  requests,
  timeZone,
  rating,
  onRate,
  onQuote,
  onNewChat,
  extraActions,
}: {
  message: Message;
  author: Author;
  /** The first of a run of messages by the same author. */
  showAuthor: boolean;
  mine: boolean;
  requests: NeedsYou[];
  timeZone: string;
  rating?: 1 | -1 | null;
  onRate?: (rating: 1 | -1 | 0) => void;
  onQuote?: (text: string) => void;
  onNewChat?: () => void;
  /** Edit or regenerate, on the member's own last exchange. */
  extraActions?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const notify = useNotify();
  const stream = useStream(message.id);
  const [speaking, setSpeaking] = useState(false);
  const streaming = message.status === 'streaming';
  const text = streaming ? liveText(message.content, stream) : message.content;
  const time = relativeTime(message.created_at, { locale, timeZone });

  if (message.role === 'event') {
    return (
      <div className="app-event-line" role="note">
        {message.content}
      </div>
    );
  }

  const copy = () =>
    void navigator.clipboard
      ?.writeText(text)
      .then(() => notify(t('message.copied')))
      .catch(() => notify(t('message.copyFailed')));

  if (message.role === 'user' && mine) {
    return (
      <article className="app-message is-mine" aria-label={t('message.you')}>
        {message.quote && <blockquote className="app-message-quote">{message.quote.text}</blockquote>}
        <div className="app-bubble">
          <Markdown text={text} />
        </div>
        <div className="app-message-meta is-mine">
          <time dateTime={message.created_at} title={fullTime(message.created_at, { locale, timeZone })}>
            {time}
          </time>
          {message.edited_at && <span>· {t('message.edited')}</span>}
          <span className="app-message-actions">
            <IconButton label={t('message.copy')} size="sm" onClick={copy}>
              <Copy size={icon.sm} />
            </IconButton>
            {extraActions}
          </span>
        </div>
      </article>
    );
  }

  const steps: Step[] = streaming
    ? (stream?.steps ?? []).map((step: LiveStep) => ({
        tool: step.tool,
        summary: step.summary,
        status: step.status,
        duration_ms: step.duration_ms,
      }))
    : message.steps;
  const assistant = message.role === 'assistant';

  return (
    <article className={cx('app-message', assistant && 'is-reply')} aria-label={author.name}>
      <div className="app-message-avatar" aria-hidden>
        {showAuthor &&
          (author.agent ? (
            <AgentAvatar agent={author.agent} size={24} state={streaming ? 'thinking' : undefined} />
          ) : (
            <MemberAvatar name={author.name} url={author.member?.avatar_url} size={24} />
          ))}
      </div>
      <div className="app-message-body">
        {showAuthor && (
          <header className="app-message-author">
            <strong>{author.name}</strong>
            <time dateTime={message.created_at} title={fullTime(message.created_at, { locale, timeZone })}>
              {time}
            </time>
          </header>
        )}
        {message.quote && <blockquote className="app-message-quote">{message.quote.text}</blockquote>}
        {text && (
          <Markdown
            text={text}
            className={cx(
              assistant && 'is-reply-text',
              streaming && 'is-streaming',
              message.status === 'failed' && 'is-failed',
            )}
          />
        )}
        {streaming && !text && !steps.length && <span className="app-typing" aria-label={t('common.loading')} />}
        {message.status === 'failed' && (
          <p className="app-message-note is-danger">
            <CircleAlert size={icon.sm} /> {t('message.failed')}
          </p>
        )}
        {message.status === 'stopped' && <p className="app-message-note">{t('message.stopped')}</p>}
        {requests.map((request) => (
          <RequestCard key={request.id} request={request} />
        ))}
        <ProcessCard steps={steps} />
        {!streaming && assistant && text && (
          <div className="app-message-actions is-reply">
            <IconButton label={t('message.copy')} size="sm" onClick={copy}>
              <Copy size={icon.sm} />
            </IconButton>
            {onRate && (
              <>
                <IconButton
                  label={t('message.helpful')}
                  size="sm"
                  aria-pressed={rating === 1}
                  onClick={() => onRate(rating === 1 ? 0 : 1)}
                >
                  <ThumbsUp size={icon.sm} />
                </IconButton>
                <IconButton
                  label={t('message.notHelpful')}
                  size="sm"
                  aria-pressed={rating === -1}
                  onClick={() => onRate(rating === -1 ? 0 : -1)}
                >
                  <ThumbsDown size={icon.sm} />
                </IconButton>
              </>
            )}
            <IconButton
              label={speaking ? t('message.stopReading') : t('message.readAloud')}
              size="sm"
              aria-pressed={speaking}
              onClick={() => {
                if (speaking) {
                  window.speechSynthesis?.cancel();
                  return setSpeaking(false);
                }
                if (readAloud(text, locale, () => setSpeaking(false))) setSpeaking(true);
                else notify(t('message.readUnsupported'));
              }}
            >
              <Volume2 size={icon.sm} />
            </IconButton>
            {onQuote && (
              <IconButton label={t('message.quote')} size="sm" onClick={() => onQuote(text)}>
                <Quote size={icon.sm} />
              </IconButton>
            )}
            {onNewChat && (
              <IconButton label={t('message.newChatFromHere')} size="sm" onClick={onNewChat}>
                <Split size={icon.sm} />
              </IconButton>
            )}
            {extraActions}
          </div>
        )}
      </div>
    </article>
  );
});
