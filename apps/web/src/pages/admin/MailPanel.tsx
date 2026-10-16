/**
 * 管理 → 服务 → 邮箱, below the instances (PRV-16): whether mail can go out (with a test mail to
 * me), the domain of Agent addresses, and for each instance that receives, the address its vendor
 * posts received mail to. Agent mailboxes exist once a receiving instance is first and the domain
 * is set.
 */

import { useState, type FormEvent } from 'react';
import { Copy } from 'lucide-react';
import { Button, ErrorBox, Field, Input, Skeleton, StatusBadge } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { AdminMail } from '@greenhouse/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';

/** Under the providers' key: a change to the mail instances refetches this too. */
const KEY = ['admin', 'providers', 'mail'] as const;

function Domain({ mail }: { mail: AdminMail }) {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const [value, setValue] = useState(mail.agent_domain ?? '');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: (agentDomain: string | null) => api.admin.mail.save({ agent_domain: agentDomain }),
    onSuccess: (saved) => {
      client.setQueryData(KEY, saved);
      setValue(saved.agent_domain ?? '');
      notify(t('common.saved'));
    },
    onError: (caught) => setError(errorText(caught, t)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(value.trim() ? value.trim().toLowerCase() : null);
  };
  return (
    <form className="app-form" onSubmit={submit}>
      <Field
        label={t('mail.admin.domain')}
        description={mail.agent_domain_source === 'env' ? t('mail.admin.domainFromEnv') : t('mail.admin.domainHint')}
        error={error || undefined}
      >
        <Input
          value={value}
          placeholder="agents.example.com"
          onChange={(event) => {
            setValue(event.target.value);
            setError('');
          }}
        />
      </Field>
      <span className="app-inline-actions">
        <Button type="submit" loading={save.isPending} disabled={value.trim() === (mail.agent_domain ?? '')}>
          {t('common.save')}
        </Button>
        {mail.agent_domain_source === 'workspace' && mail.agent_domain_env && (
          <Button kind="ghost" onClick={() => save.mutate(null)}>
            {t('mail.admin.useEnv', { domain: mail.agent_domain_env })}
          </Button>
        )}
      </span>
    </form>
  );
}

export function MailPanel() {
  const { t } = useI18n();
  const notify = useNotify();
  const data = useQuery({ queryKey: KEY, queryFn: () => api.admin.mail.get() });
  const [testing, setTesting] = useState(false);
  if (data.isPending) return <Skeleton lines={3} />;
  if (data.isError) return <ErrorBox onRetry={() => void data.refetch()}>{errorText(data.error, t)}</ErrorBox>;
  const mail = data.data;
  const test = async () => {
    setTesting(true);
    try {
      const result = await api.admin.mail.test();
      notify(
        result.ok
          ? t('mail.admin.testOk', { instance: result.instance ?? '' })
          : t('mail.admin.testFailed', { error: result.error ?? '' }),
      );
    } catch (caught) {
      notify(errorText(caught, t));
    } finally {
      setTesting(false);
    }
  };
  return (
    <section className="app-section" aria-label={t('mail.admin.title')}>
      <h3 className="app-section-title">{t('mail.admin.title')}</h3>
      {mail.can_send ? (
        <div>
          <Button size="sm" loading={testing} onClick={() => void test()}>
            {t('mail.admin.test')}
          </Button>
        </div>
      ) : (
        <p className="app-muted">{t('mail.admin.cantSend')}</p>
      )}
      <p className="app-inline-status">
        <StatusBadge
          status={mail.mailboxes ? t('provider.available') : t('provider.notConfigured')}
          tone={mail.mailboxes ? 'success' : 'neutral'}
        />
        <span className="app-muted">{mail.mailboxes ? t('mail.admin.on') : t('mail.admin.off')}</span>
      </p>
      <Domain key={mail.agent_domain ?? ''} mail={mail} />
      {mail.receivers.map((receiver) => {
        const label = t('mail.admin.inbound', { name: receiver.name });
        return (
          <div key={receiver.instance_id} className="app-stack">
            <span className="app-block-title">{label}</span>
            <span className="app-muted">{t('mail.admin.inboundHint')}</span>
            <div className="app-copy-row">
              <Input
                readOnly
                value={receiver.inbound_url}
                aria-label={label}
                onFocus={(event) => event.target.select()}
              />
              <Button
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(receiver.inbound_url)
                    .then(() => notify(t('row.linkCopied')))
                    .catch(() => notify(t('common.error')))
                }
              >
                <Copy size={icon.sm} />
                {t('row.copyLink')}
              </Button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
