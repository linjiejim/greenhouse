/**
 * A decision card (「需要你」, CONV-17): the one card layout with the status at the far right of
 * the title row and the buttons bottom left, primary first. It says what is decided, on what and
 * with what effect; once decided or expired it cannot be pressed again. A take-over or sign-in
 * card opens the Agent's screen in control, and handing the computer back wakes the Agent.
 */

import { useRef, useState, type FormEvent } from 'react';
import { CircleHelp, KeyRound, MonitorPlay, MousePointer2, ShieldCheck, Sparkles } from 'lucide-react';
import {
  Button,
  ChatCard,
  ConfirmDialog,
  Field,
  FieldGroup,
  Input,
  Overlay,
  OverlayActions,
  Select,
  Switch,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { NeedsYou, QuestionField } from '@greenhouse/contract';
import { useNotify } from '../app/notify';
import { useSession } from '../app/session';
import { ComputerScreen } from '../computer/ComputerScreen';
import { useDecide } from '../data/requests';
import { errorText } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { href, navigate } from '../lib/router';
import { relativeTime } from '../lib/time';
import { useDraftNavigation } from '../lib/useDraftNavigation';
import { inlineQuestion } from './question';
import { MarkdownPreview } from './MarkdownPreview';
import { detailRows, requestStatus } from './status';

const KIND_ICON = {
  approval: ShieldCheck,
  login: KeyRound,
  takeover: MonitorPlay,
  question: CircleHelp,
  proposal: Sparkles,
} as const;

/** Cards the member settles by handing the computer back, after doing what the Agent asked. */
const handsBack = (request: NeedsYou) => request.kind === 'takeover' || request.kind === 'login';

function Details({ request }: { request: NeedsYou }) {
  const { t } = useI18n();
  const payload = request.payload;
  if (request.kind === 'login' && typeof payload.site === 'string') {
    return (
      <dl className="app-request-details">
        <div>
          <dt>{t('request.loginSite')}</dt>
          <dd>{payload.site}</dd>
        </div>
        <div>
          <dt>{t('request.loginItem')}</dt>
          <dd>
            {String(payload.item_label ?? '')}
            {typeof payload.username_hint === 'string' && payload.username_hint ? ` · ${payload.username_hint}` : ''}
          </dd>
        </div>
      </dl>
    );
  }
  if (handsBack(request)) {
    return typeof payload.reason === 'string' && payload.reason ? (
      <div className="app-request-body">
        <p>{payload.reason}</p>
      </div>
    ) : null;
  }
  if (request.subject === 'instructions_update') {
    return (
      <div className="app-request-body">
        {typeof payload.reason === 'string' && payload.reason && <p>{payload.reason}</p>}
        <div className="app-request-label">{t('request.newInstructions')}</div>
        <MarkdownPreview text={String(payload.instructions ?? '')} />
      </div>
    );
  }
  if (request.subject === 'run_start') {
    return (
      <div className="app-request-body">
        <div className="app-request-label">{String(payload.run_title ?? '')}</div>
        <MarkdownPreview text={String(payload.brief ?? '')} />
        {typeof payload.access_summary === 'string' && <p className="app-preserve-lines">{payload.access_summary}</p>}
        {payload.continue_after === true && <p>{t('approvals.continue')}</p>}
      </div>
    );
  }
  const rows = detailRows(payload.details);
  if (rows.length) {
    return (
      <dl className="app-request-details">
        {rows.map(({ label, value, format, chips }, index) => (
          <div key={`${index}-${label}`}>
            <dt>{label}</dt>
            <dd>
              {format === 'markdown' ? (
                <MarkdownPreview text={value} />
              ) : (
                <span className="app-detail-value">
                  {chips?.length ? value.split(chips.join(' · ')).join('').replace(/ · $/, '') : value}
                </span>
              )}
              {chips?.length ? (
                <span className="app-detail-chips">
                  {chips.map((chip, index) => (
                    <span className="gh-chip" key={index}>
                      {chip}
                    </span>
                  ))}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return null;
}

function InlineChoices({ request }: { request: NeedsYou }) {
  const { t } = useI18n();
  const decide = useDecide();
  const field = inlineQuestion(request)!;
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const saved = (request.result?.answers as Record<string, string> | undefined)?.[field.key];
  const selected = request.status === 'answered' ? (saved ?? picked) : picked;
  const answer = async (option: string) => {
    if (sending.current || request.status !== 'pending') return;
    sending.current = true;
    setPicked(option);
    setError('');
    try {
      await decide.mutateAsync({ id: request.id, action: 'answer', answers: { [field.key]: option } });
    } catch (error) {
      setPicked(null);
      setError(errorText(error, t));
    } finally {
      sending.current = false;
    }
  };
  return (
    <div className="app-inline-question" role="group" aria-label={field.label} aria-busy={decide.isPending}>
      <span className="app-request-label">{field.label}</span>
      <div className="app-inline-choices">
        {field.options!.map((option) => (
          <Button
            key={option}
            aria-pressed={selected === option}
            disabled={request.status !== 'pending' || decide.isPending || picked !== null}
            onClick={() => void answer(option)}
          >
            {option}
          </Button>
        ))}
      </div>
      {error && (
        <p className="app-request-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function QuestionForm({ request, onClose }: { request: NeedsYou; onClose: () => void }) {
  const { t } = useI18n();
  const decide = useDecide();
  const fields = (request.payload.fields ?? []) as QuestionField[];
  const [answers, setAnswers] = useState<Record<string, string>>(
    (request.result?.answers as Record<string, string> | undefined) ?? {},
  );
  const [error, setError] = useState('');
  const pending = request.status === 'pending';
  const busy = useRef(false);
  const form = `answer-${request.id}`;
  const dirty = pending && Object.values(answers).some((answer) => answer.trim());
  const guard = useDraftNavigation(!!dirty, decide.isPending, onClose);
  const close = () => {
    if (decide.isPending) return false;
    if (dirty) {
      guard.ask();
      return false;
    }
    return true;
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy.current || !pending) return;
    const missing = fields.find((field) => field.required !== false && !answers[field.key]?.trim());
    if (missing) return setError(t('request.required', { name: missing.label }));
    busy.current = true;
    try {
      await decide.mutateAsync({ id: request.id, action: 'answer', answers });
      onClose();
    } catch (error) {
      setError(errorText(error, t));
    } finally {
      busy.current = false;
    }
  };
  return (
    <Overlay title={request.title} onClose={onClose} beforeClose={close}>
      <form className="app-request-form" onSubmit={(event) => void submit(event)} id={form}>
        {fields.map((field) => {
          const FormField = field.type === 'choice' && field.options?.length ? FieldGroup : Field;
          return (
            <FormField key={field.key} label={field.label} required={field.required !== false}>
              {field.type === 'choice' && field.options?.length ? (
                <Select
                  label={field.label}
                  value={answers[field.key] ?? ''}
                  options={field.options.map((option) => ({ value: option, label: option }))}
                  disabled={!pending || decide.isPending}
                  onChange={(value: string) => {
                    setAnswers({ ...answers, [field.key]: value });
                    setError('');
                  }}
                />
              ) : (
                <Input
                  value={answers[field.key] ?? ''}
                  maxLength={4000}
                  disabled={!pending || decide.isPending}
                  onChange={(event) => {
                    setAnswers({ ...answers, [field.key]: event.target.value });
                    setError('');
                  }}
                />
              )}
            </FormField>
          );
        })}
        {error && (
          <p className="app-request-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <OverlayActions>
        <Button
          disabled={decide.isPending}
          onClick={() => {
            if (close()) onClose();
          }}
        >
          {t('common.cancel')}
        </Button>
        {pending && (
          <Button kind="primary" type="submit" form={form} loading={decide.isPending}>
            {t('request.answer')}
          </Button>
        )}
      </OverlayActions>
      {guard.asking && (
        <ConfirmDialog
          title={t('knowledge.discardTitle')}
          confirmLabel={t('connectors.discard')}
          cancelLabel={t('knowledge.keepEditing')}
          danger
          onConfirm={guard.discard}
          onCancel={guard.cancel}
        />
      )}
    </Overlay>
  );
}

/**
 * The Agent's screen in control for a take-over (`screen`), or just the hand-back (`note`), with
 * a note the Agent reads when it wakes. Closing without handing back leaves the card waiting.
 */
function HandBack({ request, mode, onClose }: { request: NeedsYou; mode: 'screen' | 'note'; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const decide = useDecide();
  const [note, setNote] = useState('');
  const reason = typeof request.payload.reason === 'string' ? request.payload.reason : '';
  const form = `handback-${request.id}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    decide.mutate(
      { id: request.id, action: 'handback', note: note.trim() || undefined },
      {
        onSuccess: () => {
          notify(t('computer.handedBack'));
          onClose();
        },
        onError: (error) => notify(errorText(error, t)),
      },
    );
  };
  const screen = mode === 'screen' && request.agent_id;
  return (
    <Overlay
      variant={screen ? 'drawer' : 'dialog'}
      wide={!!screen}
      title={screen ? request.title : t('computer.handBack')}
      onClose={onClose}
    >
      <div className="app-handback">
        {reason && <p className="app-muted">{reason}</p>}
        {screen && <ComputerScreen agentId={request.agent_id!} control />}
        <form id={form} onSubmit={submit}>
          <Input
            value={note}
            maxLength={500}
            placeholder={t('computer.handBackNote')}
            aria-label={t('computer.handBackNote')}
            onChange={(event) => setNote(event.target.value)}
          />
        </form>
      </div>
      <OverlayActions>
        <Button onClick={onClose}>{screen ? t('common.close') : t('common.cancel')}</Button>
        <Button kind="primary" type="submit" form={form} loading={decide.isPending}>
          {t('computer.handBack')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}

export function RequestCard({ request, showContext = false }: { request: NeedsYou; showContext?: boolean }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const decide = useDecide();
  const [questioning, setQuestioning] = useState(false);
  const inline = inlineQuestion(request);
  const [handing, setHanding] = useState<'screen' | 'note' | null>(null);
  const [standing, setStanding] = useState(false);
  const [continueAfter, setContinueAfter] = useState(request.payload.continue_after === true);
  const status = requestStatus(request);
  const pending = request.status === 'pending';
  const Icon = KIND_ICON[request.kind];
  const meta = relativeTime(request.created_at, { locale, timeZone: me?.timezone ?? 'Asia/Shanghai' });

  const footer = pending ? (
    request.kind === 'question' ? (
      inline ? null : (
        <Button kind="primary" onClick={() => setQuestioning(true)}>
          {t('request.answer')}
        </Button>
      )
    ) : request.kind === 'approval' || request.kind === 'proposal' ? (
      <>
        <Button
          kind="primary"
          disabled={request.payload.batch_ready === false}
          loading={decide.isPending && decide.variables?.action === 'approve'}
          onClick={() =>
            decide.mutate({
              id: request.id,
              action: 'approve',
              standing,
              ...(request.subject === 'run_start' ? { continue_after: continueAfter } : {}),
            })
          }
        >
          {request.subject === 'run_start' ? t('request.startRun') : t('request.approve')}
        </Button>
        <Button
          loading={decide.isPending && decide.variables?.action === 'reject'}
          onClick={() => decide.mutate({ id: request.id, action: 'reject' })}
        >
          {t('request.reject')}
        </Button>
      </>
    ) : request.kind === 'login' && request.subject === 'vault_fill' ? (
      <>
        <Button
          kind="primary"
          loading={decide.isPending && decide.variables?.action === 'approve'}
          onClick={() => decide.mutate({ id: request.id, action: 'approve' })}
        >
          {t('request.allowLogin')}
        </Button>
        <Button
          loading={decide.isPending && decide.variables?.action === 'reject'}
          onClick={() => decide.mutate({ id: request.id, action: 'reject' })}
        >
          {t('request.reject')}
        </Button>
        {request.agent_id && me?.capabilities.sandbox && (
          <Button onClick={() => setHanding('screen')}>{t('request.signInMyself')}</Button>
        )}
      </>
    ) : handsBack(request) ? (
      <>
        {request.agent_id && me?.capabilities.sandbox && (
          <Button kind="primary" onClick={() => setHanding('screen')}>
            <MousePointer2 size={icon.sm} />
            {t('request.takeOver')}
          </Button>
        )}
        <Button onClick={() => setHanding('note')}>{t('computer.handBack')}</Button>
      </>
    ) : null
  ) : null;

  const retired = request.status === 'superseded' || request.status === 'withdrawn';
  const collapsed = retired
    ? (() => {
        const replacement = request.result?.replacement_request_id;
        const word = request.result?.reason === 'answered in chat' ? t('request.answeredInChat') : t(status.word);
        return (
          <span className="app-muted">
            {typeof replacement === 'string' && request.conversation_id ? (
              <a
                href={href({ page: 'conversation', id: request.conversation_id, request: replacement })}
                onClick={(event) => {
                  event.preventDefault();
                  navigate({ page: 'conversation', id: request.conversation_id!, request: replacement });
                  document.getElementById(`request-${replacement}`)?.scrollIntoView({ block: 'center' });
                }}
              >
                {word}
              </a>
            ) : (
              word
            )}
          </span>
        );
      })()
    : undefined;

  return (
    <div id={`request-${request.id}`}>
      <ChatCard
        icon={<Icon size={icon.md} strokeWidth={icon.stroke} />}
        title={request.title}
        meta={meta}
        status={t(status.word)}
        tone={status.tone}
        attention={pending}
        collapsed={collapsed}
        footer={
          footer || (showContext && request.conversation_id) ? (
            <>
              {showContext && request.conversation_id && (
                <a className="app-request-open" href={`#/c/${request.conversation_id}`}>
                  {t('request.openConversation')}
                </a>
              )}
              {footer}
            </>
          ) : undefined
        }
      >
        {pending ? (
          <Details request={request} />
        ) : (
          !inline && (
            <details className="app-request-settled">
              <summary>{t('request.expandPreview')}</summary>
              <Details request={request} />
            </details>
          )
        )}
        {pending && request.subject === 'run_start' && (
          <div className="app-setting-row is-plain">
            <span className="app-setting-text">{t('approvals.continue')}</span>
            <Switch checked={continueAfter} onChange={setContinueAfter} label={t('approvals.continue')} />
          </div>
        )}
        {pending && request.payload.tier === 'tier2' && !!request.payload.standing_scope && (
          <div className="app-setting-row is-plain">
            <span className="app-setting-text">
              {t(
                (request.payload.standing_scope as { type: string }).type === 'folder'
                  ? 'approvals.allowFolder'
                  : 'approvals.allowTable',
              )}
            </span>
            <Switch
              checked={standing}
              onChange={setStanding}
              label={t(
                (request.payload.standing_scope as { type: string }).type === 'folder'
                  ? 'approvals.allowFolder'
                  : 'approvals.allowTable',
              )}
            />
          </div>
        )}
        {inline && <InlineChoices key={request.id} request={request} />}
        {questioning && <QuestionForm key={request.id} request={request} onClose={() => setQuestioning(false)} />}
        {handing && pending && <HandBack request={request} mode={handing} onClose={() => setHanding(null)} />}
      </ChatCard>
    </div>
  );
}
