/**
 * 发布 (AGNT-13): a fixed version for members, groups or everyone, with the computer if wanted
 * and a daily cap per person. Its audience talks to that version with their own rights; the
 * owner sees usage and ratings, never their conversations.
 */

import { useEffect, useState, type FormEvent } from 'react';
import {
  Button,
  ConfirmDialog,
  Field,
  FieldGroup,
  Input,
  MultiSelect,
  Segmented,
  Select,
  Skeleton,
  StatusBadge,
  Switch,
} from '@greenhouse/ui/kit';
import type { AgentDetail, PublicationInput } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { useVersions } from '../../data/agents';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

export function PublishTab({ agent }: { agent: AgentDetail }) {
  const { t } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const client = useQueryClient();
  const key = ['agents', 'publication', agent.id];
  const publication = useQuery({ queryKey: key, queryFn: () => api.publication.get(agent.id) });
  const versions = useVersions(agent.id);
  const directory = useQuery({ queryKey: ['members', 'directory'], queryFn: () => api.members.directory() });
  const groups = useQuery({ queryKey: ['groups', 'directory'], queryFn: () => api.members.groups() });
  const [everyone, setEveryone] = useState(false);
  const [audience, setAudience] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [computer, setComputer] = useState(false);
  const [cap, setCap] = useState('0');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);

  // Start from what is published now.
  useEffect(() => {
    const current = publication.data;
    if (!current) return;
    setEveryone(current.audience.some((entry) => entry.type === 'workspace'));
    setAudience(current.audience.filter((entry) => entry.id).map((entry) => `${entry.type}:${entry.id}`));
    setVersion(String(current.version ?? current.current_version));
    setComputer(current.computer);
    setCap(String(current.daily_cap));
  }, [publication.data]);

  if (publication.isPending) return <Skeleton lines={4} />;
  const current = publication.data;
  const options = [
    ...(directory.data?.items ?? [])
      .filter((member) => member.id !== me.id)
      .map((member) => ({ value: `member:${member.id}`, label: member.name, description: member.email })),
    ...(groups.data?.items ?? []).map((group) => ({
      value: `group:${group.id}`,
      label: group.name,
      description: t('chat.people', { count: group.member_ids.length }),
    })),
  ];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!everyone && !audience.length) return setError(t('publish.audienceRequired'));
    const input: PublicationInput = {
      version: Number(version) || undefined,
      audience: everyone
        ? [{ type: 'workspace' }]
        : audience.map((value) => {
            const [type, id] = value.split(':') as ['member' | 'group', string];
            return { type, id };
          }),
      computer,
      daily_cap: Math.max(0, Math.floor(Number(cap) || 0)),
    };
    setSaving(true);
    try {
      const saved = await api.publication.publish(agent.id, input);
      client.setQueryData(key, saved);
      void client.invalidateQueries({ queryKey: ['agents', 'one', agent.id] });
      notify(t('publish.done', { version: saved.version ?? '' }));
    } catch (caught) {
      setError(
        caught instanceof ApiClientError && caught.code === 'model_not_shareable'
          ? t('publish.modelNotShareable')
          : caught instanceof ApiClientError
            ? caught.message
            : t('common.error'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="app-section" aria-label={t('agents.tabPublish')}>
      {current?.published && (
        <div className="app-setting-row is-plain">
          <span className="app-setting-text">
            <strong>
              {t('publish.publishedVersion', { version: current.version ?? '' })}
              {current.paused_at ? (
                <StatusBadge status={t('publicAgents.paused')} tone="neutral" />
              ) : (
                <StatusBadge status={t('publish.published')} tone="success" />
              )}
            </strong>
            <span>{current.audience.map((entry) => entry.name).join('、')}</span>
          </span>
          <Button kind="danger" onClick={() => setUnpublishing(true)}>
            {t('publish.unpublish')}
          </Button>
        </div>
      )}
      <form className="app-form" onSubmit={(event) => void submit(event)} aria-label={t('agents.tabPublish')}>
        <Field label={t('publish.version')}>
          <Select
            label={t('publish.version')}
            value={version}
            options={(versions.data?.items ?? []).map((item) => ({
              value: String(item.version),
              label: t('agents.version', { version: item.version }),
              description: item.change_note || undefined,
            }))}
            onChange={setVersion}
          />
        </Field>
        <FieldGroup label={t('publish.audience')} error={error || undefined}>
          <Segmented
            label={t('publish.audience')}
            items={[
              { value: 'some', label: t('publish.some') },
              { value: 'everyone', label: t('publish.everyone') },
            ]}
            value={everyone ? 'everyone' : 'some'}
            onChange={(value) => {
              setEveryone(value === 'everyone');
              setError('');
            }}
          />
        </FieldGroup>
        {!everyone && (
          <MultiSelect
            label={t('publish.who')}
            placeholder={t('publish.who')}
            value={audience}
            max={4}
            options={options}
            onChange={(value) => {
              setAudience(value);
              setError('');
            }}
          />
        )}
        {me.capabilities.sandbox && (
          <div className="app-setting-row is-plain">
            <span className="app-setting-text">
              <strong>{t('publish.computer')}</strong>
              <span>{t('publish.computerHint')}</span>
            </span>
            <Switch label={t('publish.computer')} checked={computer} onChange={setComputer} />
          </div>
        )}
        <Field label={t('publish.dailyCap')} description={t('publish.dailyCapHint')}>
          <Input type="number" min={0} value={cap} onChange={(event) => setCap(event.target.value)} />
        </Field>
        <div>
          <Button kind="primary" type="submit" loading={saving}>
            {current?.published ? t('publish.update') : t('publish.publish')}
          </Button>
        </div>
      </form>
      {unpublishing && (
        <ConfirmDialog
          danger
          title={t('publish.unpublishTitle', { name: agent.name })}
          confirmLabel={t('publish.unpublish')}
          onCancel={() => setUnpublishing(false)}
          onConfirm={() => {
            setUnpublishing(false);
            void api.publication
              .unpublish(agent.id)
              .then(() => client.invalidateQueries({ queryKey: key }))
              .catch((caught: unknown) =>
                notify(caught instanceof ApiClientError ? caught.message : t('common.error')),
              );
          }}
        >
          {t('publish.unpublishBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}
