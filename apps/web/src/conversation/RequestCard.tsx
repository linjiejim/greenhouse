/**
 * A decision card (「需要你」, CONV-17): the one card layout with the status at the far right of
 * the title row and the buttons bottom right, primary last. It says what is decided, on what and
 * with what effect; once decided or expired it cannot be pressed again.
 */

import { useState, type FormEvent } from 'react';
import { CircleHelp, KeyRound, MonitorPlay, ShieldCheck, Sparkles } from 'lucide-react';
import { Button, ChatCard, Field, Input, Select } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { NeedsYou, QuestionField } from '@greenhouse/contract';
import { useDecide } from '../data/requests';
import { useI18n } from '../lib/i18n';
import { relativeTime } from '../lib/time';
import { useSession } from '../app/session';
import { requestStatus } from './status';

const KIND_ICON = {
  approval: ShieldCheck,
  login: KeyRound,
  takeover: MonitorPlay,
  question: CircleHelp,
  proposal: Sparkles,
} as const;

function Details({ request }: { request: NeedsYou }) {
  const { t } = useI18n();
  const payload = request.payload;
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

export function RequestCard({ request, showContext = false }: { request: NeedsYou; showContext?: boolean }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const decide = useDecide();
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
    </ChatCard>
  );
}
