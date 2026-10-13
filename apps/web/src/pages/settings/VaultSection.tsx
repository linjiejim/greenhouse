/**
 * 设置 → 密码库 (SET-06, AGNT-21): logins my Agents sign in with on their computers. Values go in
 * and never come back (a masked user name at most). Each login says where it works, which of my
 * Agents may use it, and whether it asks me first; 使用记录 lists every use, for me only.
 */

import { useState, type FormEvent } from 'react';
import { KeyRound, Plus } from 'lucide-react';
import {
  Badge,
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Field,
  FieldGroup,
  Input,
  Menu,
  MultiSelect,
  Overlay,
  OverlayActions,
  Segmented,
  Skeleton,
  StatusBadge,
  Switch,
  Tabs,
  TextArea,
  type Tone,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { UpdateVaultItemInput, VaultAccess, VaultItem } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { useAgents } from '../../data/agents';
import { useVault, useVaultActions, useVaultLog } from '../../data/vault';
import type { MessageKey } from '../../i18n/zh';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { relativeTime } from '../../lib/time';

/** A saved value: kept as it is, replaced with what is typed, or cleared on save. */
type Value = { mode: 'keep' } | { mode: 'edit'; text: string } | { mode: 'clear' };

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);

const hostOf = (origin: string) => origin.replace(/^https?:\/\//, '');

const OUTCOME: Record<VaultAccess['outcome'], { word: MessageKey; tone: Tone }> = {
  requested: { word: 'vault.outcomeRequested', tone: 'info' },
  filled: { word: 'vault.outcomeFilled', tone: 'success' },
  declined: { word: 'vault.outcomeDeclined', tone: 'neutral' },
  origin_mismatch: { word: 'vault.outcomeMismatch', tone: 'danger' },
  no_fields: { word: 'vault.outcomeNoFields', tone: 'neutral' },
  failed: { word: 'vault.outcomeFailed', tone: 'danger' },
};

const APPROVAL: Record<NonNullable<VaultAccess['approval']>, MessageKey> = {
  auto: 'vault.approvalAuto',
  always: 'vault.approvalAlways',
  member: 'vault.approvalMember',
};

function ValueField({
  label,
  type,
  saved,
  value,
  onChange,
  help,
}: {
  label: string;
  type: 'text' | 'password';
  saved: boolean;
  value: Value;
  onChange: (value: Value) => void;
  help?: string;
}) {
  const { t } = useI18n();
  if (saved && value.mode !== 'edit') {
    return (
      <FieldGroup label={label}>
        <span className="app-value-kept">
          <KeyRound size={icon.md} aria-hidden />
          {value.mode === 'clear' ? t('vault.willClear') : t('vault.saved')}
          {value.mode === 'clear' ? (
            <Button kind="ghost" size="sm" onClick={() => onChange({ mode: 'keep' })}>
              {t('vault.undo')}
            </Button>
          ) : (
            <>
              <Button kind="ghost" size="sm" onClick={() => onChange({ mode: 'edit', text: '' })}>
                {t('vault.replace')}
              </Button>
              <Button kind="ghost" size="sm" onClick={() => onChange({ mode: 'clear' })}>
                {t('vault.clear')}
              </Button>
            </>
          )}
        </span>
      </FieldGroup>
    );
  }
  return (
    <Field label={label} description={help}>
      <Input
        type={type}
        autoComplete="off"
        value={value.mode === 'edit' ? value.text : ''}
        onChange={(event) => onChange({ mode: 'edit', text: event.target.value })}
      />
    </Field>
  );
}

/** What to send for one value: left out keeps it, '' removes it. */
const sendValue = (value: Value) =>
  value.mode === 'clear' ? '' : value.mode === 'edit' && value.text ? value.text : undefined;

function VaultDrawer({ item, onClose }: { item: VaultItem | null; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const actions = useVaultActions();
  const agents = useAgents('mine');
  const start: Value = item ? { mode: 'keep' } : { mode: 'edit', text: '' };
  const [label, setLabel] = useState(item?.label ?? '');
  const [sites, setSites] = useState((item?.origins ?? []).join('\n'));
  const [username, setUsername] = useState<Value>(start);
  const [password, setPassword] = useState<Value>(start);
  const [totp, setTotp] = useState<Value>(start);
  const [policy, setPolicy] = useState<VaultItem['policy']>(item?.policy ?? 'ask');
  const [always, setAlways] = useState((item?.always_origins ?? []).join('\n'));
  const [everyAgent, setEveryAgent] = useState(!item?.agent_ids.length);
  const [agentIds, setAgentIds] = useState<string[]>(item?.agent_ids ?? []);
  const [error, setError] = useState('');
  const saving = actions.create.isPending || actions.update.isPending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const origins = lines(sites);
    if (!label.trim()) return setError(t('vault.labelRequired'));
    if (!origins.length) return setError(t('vault.siteRequired'));
    const values = { username: sendValue(username), password: sendValue(password), totp: sendValue(totp) };
    if (!item && !values.username && !values.password && !values.totp) return setError(t('vault.valueRequired'));
    const input: UpdateVaultItemInput = {
      label: label.trim(),
      origins,
      policy,
      always_origins: policy === 'ask' ? lines(always) : [],
      agent_ids: everyAgent ? [] : agentIds,
      ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)),
    };
    try {
      if (item) await actions.update.mutateAsync({ id: item.id, input });
      else await actions.create.mutateAsync({ ...input, label: input.label!, origins });
      notify(t('common.saved'));
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiClientError && caught.status < 500 ? caught.message : errorText(caught, t));
    }
  };

  return (
    <Overlay title={item ? item.label : t('vault.add')} onClose={onClose}>
      <form id="vault-item" className="app-form" onSubmit={(event) => void submit(event)}>
        <Field label={t('vault.label')} required>
          <Input value={label} maxLength={60} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <Field label={t('vault.sites')} description={t('vault.sitesHint')} required>
          <TextArea rows={2} value={sites} onChange={(event) => setSites(event.target.value)} />
        </Field>
        <ValueField
          label={t('vault.username')}
          type="text"
          saved={!!item?.has_username}
          value={username}
          onChange={setUsername}
        />
        <ValueField
          label={t('vault.password')}
          type="password"
          saved={!!item?.has_password}
          value={password}
          onChange={setPassword}
        />
        <ValueField
          label={t('vault.totp')}
          type="password"
          saved={!!item?.has_totp}
          value={totp}
          onChange={setTotp}
          help={t('vault.totpHint')}
        />
        <FieldGroup label={t('vault.policy')}>
          <Segmented
            label={t('vault.policy')}
            items={[
              { value: 'ask', label: t('vault.ask') },
              { value: 'auto', label: t('vault.auto') },
            ]}
            value={policy}
            onChange={(value) => setPolicy(value as VaultItem['policy'])}
          />
        </FieldGroup>
        {policy === 'ask' && (
          <Field label={t('vault.always')} description={t('vault.alwaysHint')}>
            <TextArea rows={2} value={always} onChange={(event) => setAlways(event.target.value)} />
          </Field>
        )}
        <div className="app-setting-row is-plain">
          <span className="app-setting-text">
            <strong>{t('vault.everyAgent')}</strong>
            <span>{t('vault.everyAgentHint')}</span>
          </span>
          <Switch label={t('vault.everyAgent')} checked={everyAgent} onChange={setEveryAgent} />
        </div>
        {!everyAgent && (
          <MultiSelect
            label={t('vault.agents')}
            placeholder={t('vault.agents')}
            value={agentIds}
            options={agents.items.map((agent) => ({ value: agent.id, label: agent.name }))}
            onChange={setAgentIds}
          />
        )}
        {error && (
          <p className="app-request-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button kind="primary" type="submit" form="vault-item" loading={saving}>
          {t('common.save')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}

function VaultLog() {
  const { t, locale } = useI18n();
  const me = useMe();
  const log = useVaultLog(true);
  const agents = useAgents('mine');
  if (log.isPending) return <Skeleton lines={4} />;
  if (log.isError) return <ErrorBox onRetry={() => void log.refetch()}>{errorText(log.error, t)}</ErrorBox>;
  if (!log.data.items.length) return <Empty title={t('vault.logNone')} />;
  return (
    <ul className="app-list">
      {log.data.items.map((entry) => {
        const outcome = OUTCOME[entry.outcome];
        const agent = agents.items.find((item) => item.id === entry.agent_id);
        return (
          <li key={entry.id} className="app-list-row is-static">
            <span className="app-list-main">
              <span className="app-list-title">
                {entry.item_label} · {hostOf(entry.origin)}
              </span>
              <span className="app-list-meta">
                {[agent?.name, entry.approval ? t(APPROVAL[entry.approval]) : null].filter(Boolean).join(' · ')}
              </span>
            </span>
            <time className="app-list-time" dateTime={entry.created_at}>
              {relativeTime(entry.created_at, { locale, timeZone: me.timezone })}
            </time>
            <StatusBadge status={t(outcome.word)} tone={outcome.tone} />
          </li>
        );
      })}
    </ul>
  );
}

export function VaultSection() {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const vault = useVault();
  const actions = useVaultActions();
  const [view, setView] = useState<'items' | 'log'>('items');
  const [editing, setEditing] = useState<VaultItem | 'new' | null>(null);
  const [deleting, setDeleting] = useState<VaultItem | null>(null);

  if (vault.isPending) return <Skeleton lines={4} />;
  if (vault.isError) {
    return vault.error instanceof ApiClientError && vault.error.code === 'vault_unavailable' ? (
      <Empty title={t('vault.unavailable')} description={t('vault.unavailableHint')} />
    ) : (
      <ErrorBox onRetry={() => void vault.refetch()}>{errorText(vault.error, t)}</ErrorBox>
    );
  }
  const items = vault.data.items;
  const views = [t('vault.items'), t('vault.log')];
  return (
    <section className="app-section" aria-label={t('settings.vault')}>
      <div className="app-section-heading">
        <Tabs
          label={t('settings.vault')}
          items={views}
          value={view === 'items' ? views[0]! : views[1]!}
          onChange={(label) => setView(label === views[1] ? 'log' : 'items')}
        />
        {view === 'items' && (
          <Button onClick={() => setEditing('new')}>
            <Plus size={icon.md} />
            {t('vault.add')}
          </Button>
        )}
      </div>
      {view === 'log' ? (
        <VaultLog />
      ) : !items.length ? (
        <Empty title={t('vault.none')} description={t('vault.noneHint')} />
      ) : (
        <ul className="app-list">
          {items.map((item) => (
            <li key={item.id} className="app-list-row is-static">
              <button type="button" className="app-list-main app-link-button" onClick={() => setEditing(item)}>
                <span className="app-list-title">{item.label}</span>
                <span className="app-list-meta">
                  {[
                    item.origins.map(hostOf).join('、'),
                    item.username_hint,
                    item.last_used_at
                      ? t('vault.lastUsed', {
                          time: relativeTime(item.last_used_at, { locale, timeZone: me.timezone }),
                        })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
              <Badge>{item.policy === 'auto' ? t('vault.auto') : t('vault.ask')}</Badge>
              <Menu
                label={t('row.actionsFor', { name: item.label })}
                items={[
                  { label: t('vault.edit'), onClick: () => setEditing(item) },
                  '-',
                  { label: t('row.delete'), danger: true, onClick: () => setDeleting(item) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {editing && <VaultDrawer item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          danger
          title={t('vault.deleteTitle', { name: deleting.label })}
          confirmLabel={t('row.delete')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            actions.remove.mutate(target.id, { onError: (error) => notify(errorText(error, t)) });
          }}
        >
          {t('vault.deleteBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}
