/**
 * 定时 (RUN-04): each schedule starts a background run with the same brief, in a time zone.
 * Pause, resume, run now, edit, delete; the shortest interval is 15 minutes (server rule).
 */

import { useState, type FormEvent } from 'react';
import { CalendarClock, Pause, Play, Plus, Trash2, Zap } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Field,
  FieldGroup,
  Input,
  Menu,
  Overlay,
  OverlayActions,
  Select,
  Skeleton,
  StatusBadge,
  TextArea,
  Switch,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Schedule } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { useScheduleActions, useSchedules } from '../../data/schedules';
import { describeCron, fromCron, toCron, weekdayName, type Frequency } from '../../lib/cron';
import { useI18n } from '../../lib/i18n';
import { relativeTime } from '../../lib/time';

const KINDS = ['daily', 'weekdays', 'weekly', 'monthly', 'hourly', 'custom'] as const;
const pad = (value: number) => String(value).padStart(2, '0');

function ScheduleForm({
  agentId,
  schedule,
  onClose,
}: {
  agentId: string;
  schedule: Schedule | null;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const me = useMe();
  const actions = useScheduleActions();
  const [name, setName] = useState(schedule?.name ?? '');
  const [brief, setBrief] = useState(schedule?.brief ?? '');
  const [quiet, setQuiet] = useState(schedule?.quiet ?? false);
  const [frequency, setFrequency] = useState<Frequency>(
    schedule ? fromCron(schedule.cron) : { kind: 'daily', hour: 9, minute: 0 },
  );
  const [timezone, setTimezone] = useState(schedule?.timezone ?? me.timezone);
  const [error, setError] = useState('');
  const formId = `schedule-${schedule?.id ?? 'new'}`;
  const time = 'hour' in frequency ? `${pad(frequency.hour)}:${pad(frequency.minute)}` : '';

  const setKind = (kind: (typeof KINDS)[number]) => {
    const hour = 'hour' in frequency ? frequency.hour : 9;
    const minute = 'minute' in frequency ? frequency.minute : 0;
    if (kind === 'daily' || kind === 'weekdays') setFrequency({ kind, hour, minute });
    else if (kind === 'weekly') setFrequency({ kind, weekday: 1, hour, minute });
    else if (kind === 'monthly') setFrequency({ kind, day: 1, hour, minute });
    else if (kind === 'hourly') setFrequency({ kind, minute });
    else setFrequency({ kind, cron: toCron(frequency) });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError(t('request.required', { name: t('schedules.name') }));
    if (!brief.trim()) return setError(t('request.required', { name: t('schedules.brief') }));
    const input = { name: name.trim(), brief: brief.trim(), cron: toCron(frequency), timezone, quiet };
    const done = {
      onSuccess: () => onClose(),
      onError: (caught: Error) => setError(caught instanceof ApiClientError ? caught.message : t('common.error')),
    };
    if (schedule) actions.update.mutate({ id: schedule.id, input }, done);
    else actions.create.mutate({ agent_id: agentId, ...input }, done);
  };

  return (
    <Overlay variant="dialog" wide title={schedule ? t('schedules.edit') : t('schedules.add')} onClose={onClose}>
      <form id={formId} className="app-form" onSubmit={submit}>
        <Field label={t('schedules.name')} required>
          <Input value={name} maxLength={80} autoFocus onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t('schedules.brief')} required description={t('schedules.briefHint')}>
          <TextArea value={brief} maxLength={2000} maxRows={8} onChange={(event) => setBrief(event.target.value)} />
        </Field>
        <div className="app-form-row">
          <FieldGroup label={t('schedules.frequency')}>
            <Select
              label={t('schedules.frequency')}
              value={frequency.kind}
              options={KINDS.map((kind) => ({ value: kind, label: t(`schedules.${kind}`) }))}
              onChange={(value) => setKind(value as (typeof KINDS)[number])}
            />
          </FieldGroup>
          {frequency.kind === 'weekly' && (
            <FieldGroup label={t('schedules.weekday')}>
              <Select
                label={t('schedules.weekday')}
                value={String(frequency.weekday)}
                options={[1, 2, 3, 4, 5, 6, 0].map((day) => ({ value: String(day), label: weekdayName(day, locale) }))}
                onChange={(value) => setFrequency({ ...frequency, weekday: Number(value) })}
              />
            </FieldGroup>
          )}
          {frequency.kind === 'monthly' && (
            <FieldGroup label={t('schedules.day')}>
              <Select
                label={t('schedules.day')}
                value={String(frequency.day)}
                options={Array.from({ length: 28 }, (_, index) => String(index + 1))}
                onChange={(value) => setFrequency({ ...frequency, day: Number(value) })}
              />
            </FieldGroup>
          )}
          {'hour' in frequency && (
            <Field label={t('schedules.time')}>
              <Input
                type="time"
                value={time}
                onChange={(event) => {
                  const [hour, minute] = event.target.value.split(':').map(Number);
                  if (hour !== undefined && minute !== undefined && !Number.isNaN(hour) && !Number.isNaN(minute))
                    setFrequency({ ...frequency, hour, minute });
                }}
              />
            </Field>
          )}
          {frequency.kind === 'hourly' && (
            <FieldGroup label={t('schedules.minute')}>
              <Select
                label={t('schedules.minute')}
                value={String(frequency.minute)}
                options={[0, 15, 30, 45].map((minute) => String(minute))}
                onChange={(value) => setFrequency({ kind: 'hourly', minute: Number(value) })}
              />
            </FieldGroup>
          )}
          {frequency.kind === 'custom' && (
            <Field label={t('schedules.cron')} description={t('schedules.cronHint')}>
              <Input
                value={frequency.cron}
                className="app-mono"
                onChange={(event) => setFrequency({ kind: 'custom', cron: event.target.value })}
              />
            </Field>
          )}
        </div>
        <Field label={t('schedules.timezone')}>
          <Input value={timezone} maxLength={64} onChange={(event) => setTimezone(event.target.value)} />
        </Field>
        <div className="app-setting-row is-plain">
          <span className="app-setting-text">{t('approvals.quiet')}</span>
          <Switch checked={quiet} onChange={setQuiet} label={t('approvals.quiet')} />
        </div>
        {error && (
          <p className="app-form-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          kind="primary"
          type="submit"
          form={formId}
          loading={actions.create.isPending || actions.update.isPending}
        >
          {schedule ? t('common.save') : t('schedules.create')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}

export function SchedulesTab({ agentId }: { agentId: string }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const schedules = useSchedules(agentId);
  const actions = useScheduleActions();
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const when = (iso: string | null) => (iso ? relativeTime(iso, { locale, timeZone: me.timezone }) : '—');

  return (
    <section className="app-section" aria-label={t('agents.tabSchedules')}>
      <div className="app-section-heading">
        <h2 className="app-section-title">{t('agents.tabSchedules')}</h2>
        <Button onClick={() => setEditing('new')}>
          <Plus size={icon.md} />
          {t('schedules.add')}
        </Button>
      </div>
      {schedules.isPending ? (
        <Skeleton lines={3} />
      ) : schedules.isError ? (
        <ErrorBox onRetry={() => void schedules.refetch()}>{t('common.error')}</ErrorBox>
      ) : !schedules.items.length ? (
        <Empty icon={<CalendarClock />} title={t('schedules.none')} />
      ) : (
        <ul className="app-list">
          {schedules.items.map((schedule) => (
            <li key={schedule.id} className="app-list-row is-static">
              <button type="button" className="app-list-main app-link-button" onClick={() => setEditing(schedule)}>
                <span className="app-list-title">{schedule.name}</span>
                <span className="app-list-meta">
                  {describeCron(schedule.cron, locale)} · {schedule.timezone}
                  {schedule.status === 'active' && schedule.next_run_at
                    ? ` · ${t('schedules.next', { time: when(schedule.next_run_at) })}`
                    : ''}
                </span>
              </button>
              {schedule.status === 'paused' && <StatusBadge status={t('schedules.paused')} tone="neutral" />}
              <Menu
                items={[
                  {
                    label: t('schedules.runNow'),
                    icon: <Zap size={icon.md} />,
                    onClick: () =>
                      actions.runNow.mutate(schedule.id, {
                        onSuccess: () => notify(t('schedules.started', { name: schedule.name })),
                        onError: (caught) =>
                          notify(caught instanceof ApiClientError ? caught.message : t('common.error')),
                      }),
                  },
                  schedule.status === 'active'
                    ? {
                        label: t('schedules.pause'),
                        icon: <Pause size={icon.md} />,
                        onClick: () => actions.pause.mutate(schedule.id),
                      }
                    : {
                        label: t('schedules.resume'),
                        icon: <Play size={icon.md} />,
                        onClick: () => actions.resume.mutate(schedule.id),
                      },
                  '-',
                  {
                    label: t('row.delete'),
                    icon: <Trash2 size={icon.md} />,
                    danger: true,
                    onClick: () => setDeleting(schedule),
                  },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <ScheduleForm
          agentId={agentId}
          schedule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title={t('schedules.deleteTitle', { name: deleting.name })}
          confirmLabel={t('row.delete')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            actions.remove.mutate(deleting.id);
            setDeleting(null);
          }}
        >
          {t('schedules.deleteBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}
