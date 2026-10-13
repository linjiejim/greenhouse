/**
 * One connector (ADM-08), in a drawer. On or off and a test at the top (at once); its settings
 * (one explicit save; a new address or auth mode disconnects every member, so that asks first);
 * the keys, write-only (at once); its tools, each allowed or not and run without approval or not
 * (at once: allowed_tools null is every tool, new ones too; tools the server declares read-only
 * always run freely and destructive ones never can); delete, naming what members lose.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  ErrorBox,
  HelpHint,
  Overlay,
  SecretField,
  Skeleton,
  StatusBadge,
  Switch,
  type Tone,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Connector, ConnectorTest, UpdateConnectorInput } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { connectorKeys, useAdminConnectors } from '../../data/connectors';
import type { MessageKey } from '../../i18n/zh';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { relativeTime } from '../../lib/time';
import {
  allowTool,
  disconnectsMembers,
  draftOf,
  draftProblem,
  updateInput,
  vouchTool,
  withChange,
  type ConnectorDraft,
} from './connector-draft';
import { ConnectorFields, type DraftError } from './ConnectorFields';

/** The status words of content.md: 可用, 不可用 (its last listing or test failed), 已关闭. */
export function connectorStatus(connector: Connector): { word: MessageKey; tone: Tone } {
  if (!connector.enabled) return { word: 'connectors.off', tone: 'neutral' };
  if (connector.last_error) return { word: 'connectors.failing', tone: 'danger' };
  return { word: 'connectors.ready', tone: 'success' };
}

/** The admin list with one connector replaced. */
function putConnector(client: QueryClient, id: string, next: (item: Connector) => Connector) {
  client.setQueryData<{ items: Connector[] }>(connectorKeys.admin, (data) =>
    data ? { items: data.items.map((item) => (item.id === id ? next(item) : item)) } : data,
  );
}

/** Writes one change at once: the drawer redraws before the server answers and goes back if it says no. */
function useConnectorChange(id: string) {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  return async (change: UpdateConnectorInput) => {
    const previous = client.getQueryData<{ items: Connector[] }>(connectorKeys.admin);
    putConnector(client, id, (item) => withChange(item, change));
    try {
      const saved = await api.admin.connectors.update(id, change);
      putConnector(client, id, () => saved);
      void client.invalidateQueries({ queryKey: connectorKeys.mine });
      return true;
    } catch (caught) {
      if (previous) client.setQueryData(connectorKeys.admin, previous);
      notify(errorText(caught, t));
      return false;
    }
  };
}

function Settings({ connector, onDirty }: { connector: Connector; onDirty: (dirty: boolean) => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const [draft, setDraft] = useState<ConnectorDraft>(() => draftOf(connector));
  const [error, setError] = useState<DraftError>(null);
  const [failed, setFailed] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmMove, setConfirmMove] = useState(false);
  const change = updateInput(draft, connector);
  const dirty = Object.keys(change).length > 0;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const set = (patch: Partial<ConnectorDraft>) => {
    setError(null);
    setFailed('');
    setDraft((current) => ({ ...current, ...patch }));
  };
  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.admin.connectors.update(connector.id, change);
      putConnector(client, connector.id, () => saved);
      void client.invalidateQueries({ queryKey: connectorKeys.mine });
      setDraft(draftOf(saved));
      notify(t('common.saved'));
    } catch (caught) {
      setFailed(errorText(caught, t));
    } finally {
      setSaving(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = draftProblem(draft, connector);
    if (problem) return setError({ field: problem.field, text: t(problem.word) });
    if (disconnectsMembers(change) && connector.connection_count > 0) return setConfirmMove(true);
    void save();
  };
  return (
    <section className="app-section" aria-label={t('connectors.settings')}>
      <h3 className="app-section-title">{t('connectors.settings')}</h3>
      <form className="app-form" onSubmit={submit} noValidate aria-label={t('connectors.settings')}>
        <ConnectorFields draft={draft} set={set} connector={connector} error={error} />
        {failed && (
          <p className="app-form-error" role="alert">
            {failed}
          </p>
        )}
        <div className="app-inline-actions">
          <Button kind="primary" type="submit" disabled={!dirty} loading={saving}>
            {t('connectors.saveSettings')}
          </Button>
          {dirty && (
            <Button
              kind="ghost"
              onClick={() => {
                setDraft(draftOf(connector));
                setError(null);
                setFailed('');
              }}
            >
              {t('connectors.discard')}
            </Button>
          )}
        </div>
      </form>
      {confirmMove && (
        <ConfirmDialog
          danger
          title={t('connectors.moveTitle')}
          confirmLabel={t('connectors.moveConfirm')}
          onCancel={() => setConfirmMove(false)}
          onConfirm={() => {
            setConfirmMove(false);
            void save();
          }}
        >
          {t('connectors.moveBody', { count: connector.connection_count })}
        </ConfirmDialog>
      )}
    </section>
  );
}

/** Keys after they are set: write-only, replaced or (a client secret) cleared at once. */
function Secrets({ connector }: { connector: Connector }) {
  const { t } = useI18n();
  const notify = useNotify();
  const write = useConnectorChange(connector.id);
  const shared = connector.auth_mode === 'shared';
  const manual = connector.auth_mode === 'oauth' && connector.oauth_client?.source === 'manual';
  if (!shared && !manual) return null;
  const saved = (ok: boolean) => ok && notify(t('common.saved'));
  return (
    <section className="app-section" aria-label={t('connectors.secrets')}>
      <h3 className="app-section-title">{t('connectors.secrets')}</h3>
      {shared && (
        <SecretField
          label={t('connectors.sharedKey')}
          configured={connector.shared_key_set}
          onSave={(value) => void write({ shared_key: value.trim() }).then(saved)}
        />
      )}
      {manual && (
        <>
          <SecretField
            label={t('connectors.oauthClientSecret')}
            configured={connector.oauth_client!.secret_set}
            onSave={(value) => void write({ oauth_client_secret: value.trim() }).then(saved)}
          />
          {connector.oauth_client!.secret_set && (
            <div>
              <Button kind="ghost" size="sm" onClick={() => void write({ oauth_client_secret: '' }).then(saved)}>
                {t('connectors.clearSecret')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Tools({ connector }: { connector: Connector }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const client = useQueryClient();
  const write = useConnectorChange(connector.id);
  const [refreshing, setRefreshing] = useState(false);
  const [problem, setProblem] = useState<{ text: string; connect: boolean } | null>(null);
  const personal = connector.auth_mode === 'per_member' || connector.auth_mode === 'oauth';
  const refresh = async () => {
    setRefreshing(true);
    setProblem(null);
    try {
      const listed = await api.admin.connectors.refresh(connector.id);
      putConnector(client, connector.id, () => listed);
      void client.invalidateQueries({ queryKey: connectorKeys.mine });
    } catch (caught) {
      const needsMine = caught instanceof ApiClientError && caught.code === 'connection_required';
      setProblem({ text: needsMine ? t('connectors.connectFirst') : errorText(caught, t), connect: needsMine });
    } finally {
      setRefreshing(false);
    }
  };
  const all = connector.allowed_tools === null;
  return (
    <section className="app-section" aria-label={t('connectors.tools')}>
      <div className="app-section-heading">
        <span className="app-heading-with-help">
          <h3 className="app-section-title">{t('connectors.tools')}</h3>
          <HelpHint label={t('connectors.tools')}>{t('connectors.toolsHelp')}</HelpHint>
        </span>
        <Button size="sm" loading={refreshing} onClick={() => void refresh()}>
          <RefreshCw size={icon.sm} />
          {t('connectors.refresh')}
        </Button>
      </div>
      {connector.tools_refreshed_at && (
        <p className="app-muted">
          {t('connectors.toolsMeta', {
            count: connector.tools.length,
            time: relativeTime(connector.tools_refreshed_at, { locale, timeZone: me.timezone }),
          })}
        </p>
      )}
      {problem && (
        <ErrorBox>
          {problem.text}
          {problem.connect && (
            <>
              {' '}
              <Button size="sm" onClick={() => navigate({ page: 'settings', section: 'connections' })}>
                {t('connectors.goConnect')}
              </Button>
            </>
          )}
        </ErrorBox>
      )}
      {connector.tools.length ? (
        <>
          <div className="app-setting-row is-plain">
            <span className="app-setting-text">
              <strong>{t('connectors.allTools')}</strong>
              <span>{t('connectors.allToolsHint')}</span>
            </span>
            <Switch
              label={t('connectors.allTools')}
              checked={all}
              onChange={(on) => void write({ allowed_tools: on ? null : connector.tools.map((tool) => tool.name) })}
            />
          </div>
          <div className="app-table-wrap">
            <table className="app-table">
              <thead>
                <tr>
                  <th>{t('connectors.tool')}</th>
                  <th>{t('connectors.allowed')}</th>
                  <th>{t('connectors.runsFreely')}</th>
                </tr>
              </thead>
              <tbody>
                {connector.tools.map((tool) => (
                  <tr key={tool.name}>
                    <td>
                      <span className="app-cell-stack">
                        <span className="app-mono">{tool.name}</span>
                        <span className="app-muted">
                          {[
                            tool.declared_read_only && t('connectors.declaredReadOnly'),
                            tool.destructive && t('connectors.destructive'),
                            tool.description,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </td>
                    <td>
                      <Switch
                        label={t('connectors.allowTool', { name: tool.name })}
                        checked={tool.allowed}
                        onChange={(on) => void write({ allowed_tools: allowTool(connector, tool.name, on) })}
                      />
                    </td>
                    <td>
                      <Switch
                        label={t('connectors.freeTool', { name: tool.name })}
                        checked={tool.read_only}
                        disabled={tool.declared_read_only || tool.destructive}
                        onChange={(on) => void write({ read_only_tools: vouchTool(connector, tool.name, on) })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="app-muted">{personal ? t('connectors.noToolsPersonal') : t('connectors.noTools')}</p>
      )}
    </section>
  );
}

export function ConnectorDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const connectors = useAdminConnectors();
  const connector = connectors.data?.items.find((item) => item.id === id);
  const write = useConnectorChange(id);
  const [dirty, setDirty] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ result?: ConnectorTest; text?: string; connect?: boolean } | null>(null);
  const [deleting, setDeleting] = useState(false);

  if (!connector) {
    return (
      <Overlay title={t('connectors.title')} onClose={onClose}>
        {connectors.isError ? (
          <ErrorBox onRetry={() => void connectors.refetch()}>{t('common.error')}</ErrorBox>
        ) : connectors.isPending ? (
          <Skeleton lines={6} />
        ) : (
          <ErrorBox>{t('connectors.gone')}</ErrorBox>
        )}
      </Overlay>
    );
  }

  const test = async () => {
    setTesting(true);
    setTested(null);
    try {
      setTested({ result: await api.admin.connectors.test(id) });
      void client.invalidateQueries({ queryKey: connectorKeys.admin });
    } catch (caught) {
      const needsMine = caught instanceof ApiClientError && caught.code === 'connection_required';
      setTested({ text: needsMine ? t('connectors.connectFirst') : errorText(caught, t), connect: needsMine });
    } finally {
      setTesting(false);
    }
  };

  const status = connectorStatus(connector);
  /** What Agents can call through it now, and lose with it. */
  const callable = connector.tools.filter((tool) => tool.allowed).length;
  return (
    <Overlay
      title={connector.name}
      onClose={onClose}
      beforeClose={() => {
        if (!dirty) return true;
        setDiscarding(true);
        return false;
      }}
    >
      <section className="app-section" aria-label={t('connectors.state')}>
        <div className="app-setting-row is-plain">
          <span className="app-setting-text">
            <strong>{t('connectors.enabled')}</strong>
            <span>{t('connectors.enabledHint')}</span>
          </span>
          <Switch
            label={t('connectors.enabled')}
            checked={connector.enabled}
            onChange={(enabled) => void write({ enabled })}
          />
        </div>
        <div className="app-setting-row is-plain">
          <span className="app-setting-text">
            <strong>
              <StatusBadge status={t(status.word)} tone={status.tone} />
              {t('connectors.people', { count: connector.connection_count })}
            </strong>
            <span>{connector.last_error ?? connector.url}</span>
          </span>
          <Button loading={testing} onClick={() => void test()}>
            {t('connectors.test')}
          </Button>
        </div>
        {tested?.result &&
          (tested.result.ok ? (
            <p className="app-muted" role="status">
              {t('connectors.testOk', { count: tested.result.tool_count ?? 0, ms: tested.result.latency_ms })}
            </p>
          ) : (
            <p className="app-form-error" role="alert">
              {t('connectors.testFailed', { error: tested.result.error ?? '' })}
            </p>
          ))}
        {tested?.text && (
          <ErrorBox>
            {tested.text}
            {tested.connect && (
              <>
                {' '}
                <Button size="sm" onClick={() => navigate({ page: 'settings', section: 'connections' })}>
                  {t('connectors.goConnect')}
                </Button>
              </>
            )}
          </ErrorBox>
        )}
      </section>
      <Settings key={connector.id} connector={connector} onDirty={setDirty} />
      <Secrets connector={connector} />
      <Tools connector={connector} />
      <section className="app-section">
        <div>
          <Button kind="danger" onClick={() => setDeleting(true)}>
            {t('connectors.delete')}
          </Button>
        </div>
      </section>
      {discarding && (
        <ConfirmDialog
          danger
          title={t('connectors.discardTitle')}
          cancelLabel={t('connectors.keepEditing')}
          confirmLabel={t('connectors.discard')}
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            setDiscarding(false);
            onClose();
          }}
        >
          {t('connectors.discardBody')}
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title={t('connectors.deleteTitle', { name: connector.name })}
          confirmLabel={t('connectors.delete')}
          onCancel={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            void api.admin.connectors
              .remove(id)
              .then(() => {
                notify(t('connectors.deleted', { name: connector.name }));
                onClose();
                void client.invalidateQueries({ queryKey: connectorKeys.admin });
                return client.invalidateQueries({ queryKey: connectorKeys.mine });
              })
              .catch((caught: unknown) => notify(errorText(caught, t)));
          }}
        >
          {connector.connection_count
            ? t('connectors.deleteBody', { count: connector.connection_count, tools: callable })
            : t('connectors.deleteBodyNobody', { tools: callable })}
        </ConfirmDialog>
      )}
    </Overlay>
  );
}
