/**
 * A decision card (「需要你」, CONV-17): the one card layout with the status at the far right of
 * the title row and the buttons bottom right, primary last. It says what is decided, on what and
 * with what effect; once decided or expired it cannot be pressed again. A take-over or sign-in
 * card opens the Agent's screen in control, and handing the computer back wakes the Agent.
 */

import { useState, type FormEvent } from 'react';
import { CircleHelp, KeyRound, MonitorPlay, MousePointer2, ShieldCheck, Sparkles } from 'lucide-react';
import { Button, ChatCard, Field, Input, Overlay, OverlayActions, Select } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { NeedsYou, QuestionField } from '@greenhouse/contract';
import { useNotify } from '../app/notify';
import { useSession } from '../app/session';
import { ComputerScreen } from '../computer/ComputerScreen';
import { useDecide } from '../data/requests';
import { errorText } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { relativeTime } from '../lib/time';
import { requestStatus } from './status';

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
        <pre className="app-request-text">{String(payload.instructions ?? '')}</pre>
      </div>
    );
  }
  if (request.subject === 'run_start') {
    return (
      <div className="app-request-body">
        <div className="app-request-label">{String(payload.run_title ?? '')}</div>
        <pre className="app-request-text">{String(payload.brief ?? '')}</pre>
      </div>
    );
  }
  const details = payload.details;
  if (request.kind === 'approval' && details && typeof details === 'object') {
    return (
      <dl className="app-request-details">
        {Object.entries(details as Record<string, unknown>).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return null;
}

function QuestionForm({ request, disabled }: { request: NeedsYou; disabled: boolean }) {
  const { t } = useI18n();
  const decide = useDecide();
  const fields = (request.payload.fields ?? []) as QuestionField[];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missing = fields.find((field) => field.required !== false && !answers[field.key]?.trim());
    if (missing) return setError(t('request.required', { name: missing.label }));
    decide.mutate({ id: request.id, action: 'answer', answers }, { onError: () => setError(t('common.error')) });
  };
  return (
    <form className="app-request-form" onSubmit={submit} id={`answer-${request.id}`}>
      {fields.map((field) => (
        <Field key={field.key} label={field.label}>
          {field.type === 'choice' && field.options?.length ? (
            <Select
              label={field.label}
              value={answers[field.key] ?? ''}
              options={field.options.map((option) => ({ value: option, label: option }))}
              disabled={disabled}
              onChange={(value: string) => setAnswers({ ...answers, [field.key]: value })}
            />
          ) : (
            <Input
              value={answers[field.key] ?? ''}
              disabled={disabled}
              onChange={(event) => {
                setAnswers({ ...answers, [field.key]: event.target.value });
                setError('');
              }}
            />
          )}
        </Field>
      ))}
      {error && (
        <p className="app-request-error" role="alert">
          {error}
        </p>
      )}
    </form>
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
  const [handing, setHanding] = useState<'screen' | 'note' | null>(null);
  const status = requestStatus(request);
  const pending = request.status === 'pending';
  const Icon = KIND_ICON[request.kind];
  const meta = relativeTime(request.created_at, { locale, timeZone: me?.timezone ?? 'Asia/Shanghai' });

  const footer = pending ? (
    request.kind === 'question' ? (
      <Button kind="primary" type="submit" form={`answer-${request.id}`} loading={decide.isPending}>
        {t('request.answer')}
      </Button>
    ) : request.kind === 'approval' || request.kind === 'proposal' ? (
      <>
        <Button
          loading={decide.isPending && decide.variables?.action === 'reject'}
          onClick={() => decide.mutate({ id: request.id, action: 'reject' })}
        >
          {t('request.reject')}
        </Button>
        <Button
          kind="primary"
          loading={decide.isPending && decide.variables?.action === 'approve'}
          onClick={() => decide.mutate({ id: request.id, action: 'approve' })}
        >
          {request.subject === 'run_start' ? t('request.startRun') : t('request.approve')}
        </Button>
      </>
    ) : handsBack(request) ? (
      <>
        <Button onClick={() => setHanding('note')}>{t('computer.handBack')}</Button>
        {request.agent_id && me?.capabilities.sandbox && (
          <Button kind="primary" onClick={() => setHanding('screen')}>
            <MousePointer2 size={icon.sm} />
            {t('request.takeOver')}
          </Button>
        )}
      </>
    ) : null
  ) : null;

  return (
    <ChatCard
      icon={<Icon size={icon.md} strokeWidth={icon.stroke} />}
      title={request.title}
      meta={meta}
      status={t(status.word)}
      tone={status.tone}
      attention={pending}
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
      footerEnd
    >
      <Details request={request} />
      {request.kind === 'question' && <QuestionForm request={request} disabled={!pending} />}
      {handing && pending && <HandBack request={request} mode={handing} onClose={() => setHanding(null)} />}
    </ChatCard>
  );
}
