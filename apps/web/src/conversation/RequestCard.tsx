/**
 * A decision card (「需要你」, CONV-17): the one card layout with the status at the far right of
 * the title row and the buttons bottom right, primary last. It says what is decided, on what and
 * with what effect; once decided or expired it cannot be pressed again. A take-over or sign-in
 * card opens the Agent's screen in control, and handing the computer back wakes the Agent.
 */

import { useState, type FormEvent } from 'react';
import { CircleHelp, KeyRound, MonitorPlay, MousePointer2, ShieldCheck, Sparkles } from 'lucide-react';
import {
  Button,
  ChatCard,
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
import { relativeTime } from '../lib/time';
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
        {payload.computer === true && (
          <p>
            {t('approvals.computer')} · {t('approvals.domains')}:{' '}
            {Array.isArray(payload.domains) ? payload.domains.join(' · ') || '—' : '—'}
            <br />
            {t('approvals.offline')}
          </p>
        )}
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
                    <span key={index}>{chip}</span>
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
      {fields.map((field) => {
        const FormField = field.type === 'choice' && field.options?.length ? FieldGroup : Field;
        return (
          <FormField key={field.key} label={field.label} required={field.required !== false}>
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
          </FormField>
        );
      })}
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
  const [standing, setStanding] = useState(false);
  const [continueAfter, setContinueAfter] = useState(request.payload.continue_after === true);
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
      </>
    ) : request.kind === 'login' && request.subject === 'vault_fill' ? (
      <>
        <Button
          loading={decide.isPending && decide.variables?.action === 'reject'}
          onClick={() => decide.mutate({ id: request.id, action: 'reject' })}
        >
          {t('request.reject')}
        </Button>
        {request.agent_id && me?.capabilities.sandbox && (
          <Button onClick={() => setHanding('screen')}>{t('request.signInMyself')}</Button>
        )}
        <Button
          kind="primary"
          loading={decide.isPending && decide.variables?.action === 'approve'}
          onClick={() => decide.mutate({ id: request.id, action: 'approve' })}
        >
          {t('request.allowLogin')}
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
      {request.kind === 'question' && <QuestionForm request={request} disabled={!pending} />}
      {handing && pending && <HandBack request={request} mode={handing} onClose={() => setHanding(null)} />}
    </ChatCard>
  );
}
