/**
 * 邮箱 (AGNT-30): the Agent's own address (copy it, change the part before @), whose mail wakes
 * it (the owner always, workspace members unless turned off, addresses let in), and the mail that
 * waits to be let in. Letting a sender in delivers what waited into the Agent's thread.
 */

import { useState, type FormEvent } from 'react';
import { Copy, X } from 'lucide-react';
import { Button, Empty, ErrorBox, Field, IconButton, Input, Skeleton, StatusBadge, Switch } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { MailItem } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { MailDrawer } from '../../conversation/MailDrawer';
import {
  useAddSender,
  useMailbox,
  useMailList,
  useReleaseMail,
  useRemoveSender,
  useUpdateMailbox,
} from '../../data/mail';
import type { MessageKey } from '../../i18n/zh';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { relativeTime } from '../../lib/time';

const REASON: Record<NonNullable<MailItem['screen_reason']>, MessageKey> = {
  sender: 'mail.reason.sender',
  unverified: 'mail.reason.unverified',
  public_agent: 'mail.reason.public_agent',
  archived: 'mail.reason.archived',
};

function Prefix({
  agentId,
  current,
  domain,
  onDone,
}: {
  agentId: string;
  current: string;
  domain: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const update = useUpdateMailbox(agentId);
  const [value, setValue] = useState(current);
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      { local_part: value.trim().toLowerCase() },
      {
        onSuccess: onDone,
        onError: (caught) =>
          setError(
            caught instanceof ApiClientError && caught.code === 'mailbox_taken'
              ? t('mail.prefixTaken')
              : caught instanceof ApiClientError && caught.code === 'mailbox_reserved'
                ? t('mail.prefixReserved')
                : caught instanceof ApiClientError && caught.code === 'invalid_input'
                  ? t('mail.prefixHint')
                  : errorText(caught, t),
          ),
      },
    );
  };
  return (
    <form className="app-form" onSubmit={submit}>
      <Field label={t('mail.prefix', { domain })} description={t('mail.prefixHint')} error={error || undefined}>
        <Input
          value={value}
          autoFocus
          maxLength={40}
          onChange={(event) => {
            setValue(event.target.value);
            setError('');
          }}
        />
      </Field>
      <span className="app-inline-actions">
        <Button onClick={onDone}>{t('common.cancel')}</Button>
        <Button kind="primary" type="submit" loading={update.isPending} disabled={!value.trim()}>
          {t('common.save')}
        </Button>
      </span>
    </form>
  );
}

function Screened({ agentId }: { agentId: string }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const list = useMailList(agentId, 'screened');
  const release = useReleaseMail(agentId);
  const [open, setOpen] = useState<string | null>(null);
  if (list.isPending) return <Skeleton lines={2} />;
  if (list.isError) return <ErrorBox onRetry={() => void list.refetch()}>{errorText(list.error, t)}</ErrorBox>;
  return (
    <>
      {list.items.length ? (
        <ul className="app-list app-bordered">
          {list.items.map((mail) => (
            <li key={mail.id} className="app-list-row is-static">
              <span className="app-list-main">
                <span className="app-list-title">{mail.subject || t('mail.noSubject')}</span>
                <span className="app-list-meta">
                  {mail.from.name ? `${mail.from.name} <${mail.from.address}>` : mail.from.address} ·{' '}
                  {relativeTime(mail.at, { locale, timeZone: me.timezone })}
                </span>
              </span>
              {mail.screen_reason && <StatusBadge status={t(REASON[mail.screen_reason])} tone="neutral" />}
              <Button size="sm" kind="ghost" onClick={() => setOpen(mail.id)}>
                {t('mail.view')}
              </Button>
              <Button
                size="sm"
                loading={release.isPending && release.variables === mail.id}
                onClick={() =>
                  release.mutate(mail.id, {
                    onSuccess: (done) => notify(t('mail.released', { sender: done.sender, count: done.delivered })),
                    onError: (caught) => notify(errorText(caught, t)),
                  })
                }
              >
                {t('mail.release')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="app-muted">{t('mail.screenedNone')}</p>
      )}
      {open && <MailDrawer agentId={agentId} mailId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function MailboxTab({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useI18n();
  const notify = useNotify();
  const mailbox = useMailbox(agentId);
  const update = useUpdateMailbox(agentId);
  const add = useAddSender(agentId);
  const remove = useRemoveSender(agentId);
  const [editing, setEditing] = useState(false);
  const [sender, setSender] = useState('');
  const [senderError, setSenderError] = useState('');

  if (mailbox.isPending) return <Skeleton lines={5} />;
  if (mailbox.isError) return <ErrorBox onRetry={() => void mailbox.refetch()}>{errorText(mailbox.error, t)}</ErrorBox>;
  const box = mailbox.data;
  if (!box.available) return <Empty title={t('mail.admin.off')} />;

  const addSender = (event: FormEvent) => {
    event.preventDefault();
    if (!sender.trim()) return;
    add.mutate(sender.trim(), {
      onSuccess: () => setSender(''),
      onError: (caught) =>
        setSenderError(
          caught instanceof ApiClientError && caught.code === 'invalid_input'
            ? t('mail.senderLabel')
            : errorText(caught, t),
        ),
    });
  };

  return (
    <>
      <section className="app-section" aria-label={t('mail.address')}>
        <h2 className="app-section-title">{t('mail.address')}</h2>
        <p className="app-muted">{t('mail.addressHint', { name })}</p>
        {editing ? (
          <Prefix agentId={agentId} current={box.local_part} domain={box.domain} onDone={() => setEditing(false)} />
        ) : (
          <div className="app-copy-row">
            <Input
              readOnly
              value={box.address}
              aria-label={t('mail.address')}
              onFocus={(event) => event.target.select()}
            />
            <Button
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(box.address)
                  .then(() => notify(t('mail.copied')))
                  .catch(() => notify(t('common.error')))
              }
            >
              <Copy size={icon.sm} />
              {t('mail.copy')}
            </Button>
            <Button kind="ghost" onClick={() => setEditing(true)}>
              {t('mail.changePrefix')}
            </Button>
          </div>
        )}
      </section>

      <section className="app-section" aria-label={t('mail.senders')}>
        <h2 className="app-section-title">{t('mail.senders')}</h2>
        <p className="app-muted">{t('mail.sendersHint')}</p>
        <ul className="app-list app-bordered">
          <li className="app-list-row is-static">
            <span className="app-list-main">
              <span className="app-list-title">{t('mail.owner')}</span>
              <span className="app-list-meta">{t('mail.ownerHint')}</span>
            </span>
          </li>
          <li className="app-list-row is-static">
            <span className="app-list-main">
              <span className="app-list-title">{t('mail.members')}</span>
              <span className="app-list-meta">{t('mail.membersHint')}</span>
            </span>
            <Switch
              label={t('mail.members')}
              checked={box.allow_members}
              disabled={update.isPending}
              onChange={(on) =>
                update.mutate({ allow_members: on }, { onError: (caught) => notify(errorText(caught, t)) })
              }
            />
          </li>
          {box.senders.map((entry) => (
            <li key={entry.address} className="app-list-row is-static">
              <span className="app-list-main">
                <span className="app-list-title">{entry.address}</span>
              </span>
              <IconButton
                label={t('mail.removeSender', { address: entry.address })}
                size="sm"
                onClick={() => remove.mutate(entry.address, { onError: (caught) => notify(errorText(caught, t)) })}
              >
                <X size={icon.sm} />
              </IconButton>
            </li>
          ))}
        </ul>
        <form className="app-copy-row" onSubmit={addSender}>
          <Input
            type="email"
            value={sender}
            placeholder="name@example.com"
            aria-label={t('mail.senderLabel')}
            onChange={(event) => {
              setSender(event.target.value);
              setSenderError('');
            }}
          />
          <Button type="submit" loading={add.isPending} disabled={!sender.trim()}>
            {t('mail.addSender')}
          </Button>
        </form>
        {senderError && (
          <p className="app-form-error" role="alert">
            {senderError}
          </p>
        )}
      </section>

      <section className="app-section" aria-label={t('mail.screened')}>
        <h2 className="app-section-title">
          {t('mail.screened')}
          {box.screened_count > 0 ? ` · ${box.screened_count}` : ''}
        </h2>
        <Screened agentId={agentId} />
      </section>
    </>
  );
}
