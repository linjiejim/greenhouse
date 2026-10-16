/**
 * 管理 → 服务 · 沙箱 (ADM-06): how computers are shared out (idle minutes before a stop, how many
 * may run at once) and every member's computer, which an admin can stop or reset. Never a
 * computer's screen or files: those are its member's.
 */

import { useEffect, useState, type FormEvent } from 'react';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Field,
  Input,
  Menu,
  Skeleton,
  StatusBadge,
  type Tone,
} from '@greenhouse/ui/kit';
import type { AdminComputer } from '@greenhouse/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import type { MessageKey } from '../../i18n/zh';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { relativeTime } from '../../lib/time';

const KEY = ['admin', 'computers'] as const;

const STATE: Record<AdminComputer['state'], { word: MessageKey; tone: Tone }> = {
  queued: { word: 'computer.queued', tone: 'info' },
  stopped: { word: 'computer.stopped', tone: 'neutral' },
  starting: { word: 'computer.starting', tone: 'info' },
  running: { word: 'computer.running', tone: 'info' },
  failed: { word: 'computer.failed', tone: 'danger' },
};

export function ComputersPanel() {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const client = useQueryClient();
  const data = useQuery({ queryKey: KEY, queryFn: () => api.admin.computers.list(), refetchInterval: 15_000 });
  const [idle, setIdle] = useState('');
  const [max, setMax] = useState('');
  const [restoring, setRestoring] = useState<{ computer: AdminComputer; backup: string } | null>(null);
  const [resetting, setResetting] = useState<AdminComputer | null>(null);
  const capacity = data.data?.capacity;
  useEffect(() => {
    if (!capacity) return;
    setIdle(String(capacity.idle_minutes));
    setMax(String(capacity.max_running));
  }, [capacity?.idle_minutes, capacity?.max_running]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => client.invalidateQueries({ queryKey: KEY });
  const failed = (error: unknown) => notify(errorText(error, t));
  const save = useMutation({
    mutationFn: () =>
      api.admin.computers.setCapacity({ idle_minutes: Math.floor(Number(idle)), max_running: Math.floor(Number(max)) }),
    onSuccess: () => {
      notify(t('common.saved'));
      void refresh();
    },
    onError: failed,
  });

  if (data.isPending) return <Skeleton lines={4} />;
  if (data.isError) return <ErrorBox onRetry={() => void data.refetch()}>{errorText(data.error, t)}</ErrorBox>;
  const { items, running } = data.data;

  return (
    <>
      <section className="app-section">
        <h3 className="app-section-title">{t('computers.capacity')}</h3>
        <form
          className="app-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field label={t('computers.idleMinutes')} description={t('computers.idleMinutesHint')}>
            <Input type="number" min={5} max={1440} value={idle} onChange={(event) => setIdle(event.target.value)} />
          </Field>
          <Field label={t('computers.maxRunning')} description={t('computers.maxRunningHint')}>
            <Input type="number" min={0} max={1000} value={max} onChange={(event) => setMax(event.target.value)} />
          </Field>
          <div>
            <Button type="submit" loading={save.isPending}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      </section>
      <section className="app-section">
        <h3 className="app-section-title">{t('computers.list', { running, count: items.length })}</h3>
        {!items.length ? (
          <Empty title={t('computers.none')} />
        ) : (
          <ul className="app-list">
            {items.map((item) => {
              const state = STATE[item.state];
              const name = `${item.agent_name} · ${item.owner_name}`;
              return (
                <li key={item.id} className="app-list-row is-static app-computer-row">
                  <span className="app-list-main">
                    <span className="app-list-title">{name}</span>
                    <span className="app-list-meta">
                      {item.queue_position
                        ? t('computer.queuePosition', { position: item.queue_position })
                        : item.state_reason && item.state === 'failed'
                          ? item.state_reason
                          : item.last_active_at
                            ? t('computer.lastActive', {
                                time: relativeTime(item.last_active_at, { locale, timeZone: me.timezone }),
                              })
                            : t('computer.never')}
                    </span>
                  </span>
                  <div className="app-computer-backups">
                    {item.backups.map((backup) => (
                      <div key={backup.id}>
                        <span>
                          {t('computers.backup')} · {relativeTime(backup.created_at, { locale, timeZone: me.timezone })}{' '}
                          · {backup.status === 'complete' ? t('status.done') : t('status.failed')}
                        </span>
                        {backup.status === 'complete' && (
                          <Button
                            size="sm"
                            disabled={item.state !== 'stopped'}
                            onClick={() => setRestoring({ computer: item, backup: backup.id })}
                          >
                            {t('computers.restore')}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  <span className="app-computer-state">
                    <StatusBadge status={t(state.word)} tone={state.tone} />
                  </span>
                  <Menu
                    label={t('row.actionsFor', { name })}
                    items={[
                      {
                        label: t('computer.stop'),
                        disabled: item.state !== 'running' && item.state !== 'queued',
                        onClick: () =>
                          void api.admin.computers
                            .stop(item.id)
                            .then(() => refresh())
                            .catch(failed),
                      },
                      {
                        label: t('computers.backup'),
                        disabled: item.state !== 'running',
                        onClick: () => void api.admin.computers.backup(item.id).then(refresh).catch(failed),
                      },
                      '-',
                      { label: t('computers.reset'), danger: true, onClick: () => setResetting(item) },
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {restoring && (
        <ConfirmDialog
          danger
          title={t('computers.restore')}
          confirmLabel={t('computers.restore')}
          onCancel={() => setRestoring(null)}
          onConfirm={() => {
            const target = restoring;
            setRestoring(null);
            void api.admin.computers.restore(target.computer.id, target.backup).then(refresh).catch(failed);
          }}
        >
          {t('computers.restoreBody')}
        </ConfirmDialog>
      )}
      {resetting && (
        <ConfirmDialog
          danger
          title={t('computers.resetTitle', { name: `${resetting.agent_name} · ${resetting.owner_name}` })}
          confirmLabel={t('computers.reset')}
          onCancel={() => setResetting(null)}
          onConfirm={() => {
            const target = resetting;
            setResetting(null);
            void api.admin.computers
              .reset(target.id)
              .then(() => refresh())
              .catch(failed);
          }}
        >
          {t('computers.resetBody')}
        </ConfirmDialog>
      )}
    </>
  );
}
