import { api } from '../lib/api';
/**
 * One message (conversation.md): the member's own words in a light bubble on the right; an
 * Agent's reply without a bubble in bodyLg, in the order conclusion → result cards → decisions
 * → process. Events are one quiet line. Actions show on hover (long press on touch).
 */

import { memo, useState } from 'react';
import { WriteReceipt } from './WriteReceipt';
import {
  CircleAlert,
  Copy,
  Pencil,
  Quote,
  RotateCcw,
  Split,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  Wand2,
  Wrench,
} from 'lucide-react';
import { Button, ChatCard, IconButton, TextArea, Tooltip } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Agent, MemberSummary, Message, NeedsYou } from '@greenhouse/contract';
import { useNotify } from '../app/notify';
import { useSession } from '../app/session';
import { RUN_STATUS } from '../pages/runs/status';
import { useHelperRuns } from '../data/runs';
import { useSkills } from '../data/skills';
import { liveText, useStream, type LiveStep } from '../data/streams';
import { cx } from '../lib/cx';
import { errorText } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { href } from '../lib/router';
import { fullTime, relativeTime } from '../lib/time';
import { AgentAvatar } from '../shell/AgentAvatar';
import { MemberAvatar } from '../shell/MemberAvatar';
import { Attachments } from './Attachments';
import { isMailEvent, MailCard } from './MailCard';
import { Markdown } from './Markdown';
import { RichContent, type BlockContext } from './rich/RichContent';
import { flattenRichOutput } from '@greenhouse/types/rich-output';

const NO_BLOCKS: BlockContext = {};
import { readAloud, readAloudMode, stopReading, useReading } from './readAloud';
import { RequestCard } from './RequestCard';
import { Sources } from './Sources';

export interface Author {
  name: string;
  agent?: Pick<Agent, 'id' | 'avatar' | 'template_key'>;
  member?: Pick<MemberSummary, 'avatar_url'>;
}

type Step = {
  tool: string;
  summary: string;
  status: 'running' | 'done' | 'failed';
  duration_ms?: number;
  recovered?: boolean;
};

/** All tool calls of a reply folded into one process card; failed ones open by default. */
function ProcessCard({ steps, runId }: { steps: Step[]; runId: string | null }) {
  const { t } = useI18n();
  const helpers = useHelperRuns(steps.some((step) => step.tool === 'helper_run') ? runId : null);
  if (!steps.length) return null;
  const running = steps.some((step) => step.status === 'running');
  const failures = steps.filter((step) => step.status === 'failed');
  const recovered = failures.length > 0 && failures.every((step) => step.recovered);
  const failed = failures.length > 0 && !recovered;
  const title = steps.length === 1 ? steps[0]!.summary : `${steps[0]!.summary}…`;
  return (
    <ChatCard
      expandable
      defaultOpen={failed}
      icon={<Wrench size={icon.md} />}
      title={title}
      meta={steps.length > 1 ? t('message.steps', { count: steps.length }) : undefined}
      status={
        running
          ? t('status.running')
          : failed
            ? t('status.failed')
            : recovered
              ? t('message.retried', { count: failures.length })
              : undefined
      }
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
        {helpers.items.map((run) => (
          <li key={run.id} className="app-step">
            <span className="app-step-dot" aria-hidden />
            <span className="app-step-summary">
              <a href={href({ page: 'run', id: run.id })}>{run.title}</a>
              {' · '}
              {t(RUN_STATUS[run.status].word)}
              {run.summary && <p className="app-muted">{run.summary}</p>}
            </span>
          </li>
        ))}
      </ol>
    </ChatCard>
  );
}

/** The skill a member ran with `/`, with the values they filled in. */
function SkillTag({ id, variables }: { id: string; variables: Record<string, string> }) {
  const { t } = useI18n();
  const skill = useSkills().items.find((item) => item.id === id);
  const filled = Object.values(variables).filter(Boolean);
  return (
    <a className="app-skill-tag" href={href({ page: 'skill', id })}>
      <Wand2 size={icon.sm} aria-hidden />
      {skill ? `/${skill.name}` : t('composer.skills')}
      {filled.length > 0 && <span className="app-muted"> · {filled.join(' · ')}</span>}
    </a>
  );
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
  onEdit,
  onRegenerate,
  busyReason,
  readBy,
  blockContext,
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
  /** The member's own last message: edit it in place. */
  onEdit?: (content: string) => Promise<unknown>;
  /** The last reply to the member: write it again. */
  onRegenerate?: () => void;
  /** Why edit and regenerate wait (a reply is being written). */
  busyReason?: string;
  /** In a room: the people who have read my message. */
  readBy?: string[];
  /** What a reply's block buttons and page previews can do. */
  blockContext?: BlockContext;
}) {
  const { t, locale } = useI18n();
  const notify = useNotify();
  const stream = useStream(message.id);
  const { me } = useSession();
  // The TTS service when one serves me, else the browser's voice; hidden when there is neither.
  const voice = readAloudMode(me?.capabilities.tts);
  const speaking = useReading(message.id);
  /** Why reading aloud failed, under the reply's actions until the next try. */
  const [readError, setReadError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const streaming = message.status === 'streaming';
  const text = streaming ? liveText(message.content, stream) : message.content;
  const time = relativeTime(message.created_at, { locale, timeZone });

  if (message.role === 'event') {
    if (message.event?.type === 'write_receipt') return <WriteReceipt message={message} />;
    // A mail that arrived at the Agent's address, or one it sent: a card that opens the mail.
    if (isMailEvent(message.event)) return <MailCard message={message as Message & { event: typeof message.event }} />;
    return (
      <div className="app-event-line" role="note">
        {message.content}
      </div>
    );
  }

  const copy = () =>
    void navigator.clipboard
      ?.writeText(message.role === 'assistant' ? flattenRichOutput(text) : text)
      .then(() => notify(t('message.copied')))
      .catch(() => notify(t('message.copyFailed')));

  if (message.role === 'user' && mine) {
    if (editing !== null) {
      const save = async () => {
        if (!editing.trim() || editing === message.content) return setEditing(null);
        setSaving(true);
        try {
          await onEdit?.(editing.trim());
          setEditing(null);
        } finally {
          setSaving(false);
        }
      };
      return (
        <article className="app-message is-mine" aria-label={t('message.you')}>
          <div className="app-bubble is-editing">
            <TextArea
              aria-label={t('message.edit')}
              value={editing}
              maxRows={12}
              autoFocus
              onChange={(event) => setEditing(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setEditing(null);
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void save();
                }
              }}
            />
            <div className="app-bubble-actions">
              <Button size="sm" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" kind="primary" loading={saving} onClick={() => void save()}>
                {t('message.saveEdit')}
              </Button>
            </div>
          </div>
        </article>
      );
    }
    return (
      <article className="app-message is-mine" aria-label={t('message.you')}>
        {message.quote && <blockquote className="app-message-quote">{message.quote.text}</blockquote>}
        {message.skill && <SkillTag id={message.skill.skill_id} variables={message.skill.variables} />}
        {text && (
          <div className="app-bubble">
            <Markdown text={text} />
          </div>
        )}
        <Attachments ids={message.attachments} mine />
        {message.event?.type === 'interjection' && (
          <span className="app-message-queue" role="status">
            {t(
              message.event.state === 'incorporated'
                ? 'message.incorporated'
                : message.event.state === 'canceled'
                  ? 'message.stopped'
                  : 'message.waiting',
            )}
          </span>
        )}
        <div className="app-message-meta is-mine">
          <time dateTime={message.created_at} title={fullTime(message.created_at, { locale, timeZone })}>
            {time}
          </time>
          {message.edited_at && <span>· {t('message.edited')}</span>}
          {readBy && readBy.length > 0 && (
            <Tooltip label={readBy.join('、')}>
              <span
                className="app-read-by"
                tabIndex={0}
                aria-label={t('message.readByNames', { names: readBy.join('、') })}
              >
                · {t('message.readBy', { count: readBy.length })}
              </span>
            </Tooltip>
          )}
          <span className="app-message-actions">
            <IconButton label={t('message.copy')} size="sm" onClick={copy}>
              <Copy size={icon.sm} />
            </IconButton>
            {onEdit && (
              <IconButton
                label={t('message.edit')}
                size="sm"
                disabled={!!busyReason}
                disabledReason={busyReason}
                onClick={() => setEditing(message.content)}
              >
                <Pencil size={icon.sm} />
              </IconButton>
            )}
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
        {text &&
          (assistant ? (
            <RichContent
              text={text}
              streaming={streaming}
              failed={message.status === 'failed'}
              context={{
                ...(blockContext ?? NO_BLOCKS),
                onDownload: () => {
                  void api.metrics.adopt({ kind: 'download', message_id: message.id }).catch(() => undefined);
                },
              }}
            />
          ) : (
            <Markdown text={text} />
          ))}
        <Attachments ids={message.attachments} />
        {!streaming && message.citations.length > 0 && (
          <Sources
            items={message.citations}
            onAsk={
              onQuote &&
              ((source) => {
                void api.metrics.adopt({ kind: 'citation', message_id: message.id }).catch(() => undefined);
                onQuote(`${source.title}${source.url ? ` — ${source.url}` : ''}`);
              })
            }
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
        <ProcessCard steps={steps} runId={message.run_id} />
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
            {voice && (
              <IconButton
                label={speaking ? t('message.stopReading') : t('message.readAloud')}
                size="sm"
                aria-pressed={speaking}
                onClick={() => {
                  if (speaking) return stopReading();
                  setReadError('');
                  readAloud(message.id, text, { mode: voice, locale }).catch((error: unknown) =>
                    setReadError(t('message.readFailed', { reason: errorText(error, t) })),
                  );
                }}
              >
                <Volume2 size={icon.sm} />
              </IconButton>
            )}
            {onQuote && (
              <IconButton
                label={t('message.quote')}
                size="sm"
                onClick={() => {
                  void api.metrics.adopt({ kind: 'citation', message_id: message.id }).catch(() => undefined);
                  onQuote(text);
                }}
              >
                <Quote size={icon.sm} />
              </IconButton>
            )}
            {onNewChat && (
              <IconButton label={t('message.newChatFromHere')} size="sm" onClick={onNewChat}>
                <Split size={icon.sm} />
              </IconButton>
            )}
            {onRegenerate && (
              <IconButton
                label={t('message.regenerate')}
                size="sm"
                disabled={!!busyReason}
                disabledReason={busyReason}
                onClick={onRegenerate}
              >
                <RotateCcw size={icon.sm} />
              </IconButton>
            )}
          </div>
        )}
        {readError && (
          <p className="app-request-error" role="alert">
            {readError}
          </p>
        )}
      </div>
    </article>
  );
});
