import { useOverlayDraft } from '../../lib/useOverlayDraft';
/**
 * 设置 → 连接 (SET-03, SET-05): the connectors I can use and my connections to them. A key is
 * checked against the server before it is kept (a refusal shows under the field); a sign-in goes
 * to the provider and comes back here with `oauth_state` and `oauth_code`, which this page
 * finishes with my own session and then clears from the address (what became of it is kept in
 * oauth-return.ts, since clearing the address remounts the page). Connectors that need no
 * connection (none, shared) are ready as they are. The built-in mailbox connects my own mailbox
 * with its IMAP and SMTP settings (MailboxDialog).
 */

import { useEffect, useState, type FormEvent } from 'react';
import { ExternalLink, Link2 } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Field,
  Input,
  Menu,
  Overlay,
  OverlayActions,
  Skeleton,
  Spinner,
  StatusBadge,
  type MenuEntry,
  type Tone,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { AvailableConnector, Connection, ConnectorAuthMode, MyConnections } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { connectorKeys, useMyConnections } from '../../data/connectors';
import type { MessageKey } from '../../i18n/zh';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n, type Translate } from '../../lib/i18n';
import { navigate, useRoute } from '../../lib/router';
import { MailboxDialog } from './MailboxDialog';
import { readOAuthReturn, setSignInOutcome, useSignInOutcome, type OAuthReturn } from './oauth-return';

/** Sign-ins being finished: a code is spent once, and React runs a mount effect twice in development. */
const finishing = new Set<string>();

/** A connector I can use, my connection to it, or both (a connection outlives its connector being turned off). */
interface Row {
  id: string;
  name: string;
  /** null: an admin turned it off. */
  connector: AvailableConnector | null;
  connection: Connection | null;
}

function rowsOf(data: MyConnections, t: Translate): Row[] {
  // A mailbox connection belongs to the built-in mailbox connector.
  const mine = data.items.filter((item) => (item.kind === 'connector' || item.kind === 'email') && item.connector);
  const rows: Row[] = data.connectors.map((connector) => ({
    id: connector.id,
    name: connector.builtin === 'mailbox' ? t('connections.mailbox') : connector.name,
    connector,
    connection: mine.find((item) => item.connector!.id === connector.id) ?? null,
  }));
  for (const connection of mine) {
    if (rows.some((row) => row.id === connection.connector!.id)) continue;
    rows.push({ id: connection.connector!.id, name: connection.connector!.name, connector: null, connection });
  }
  return rows;
}

const MODE: Record<ConnectorAuthMode, MessageKey> = {
  none: 'connections.modeNone',
  shared: 'connections.modeShared',
  per_member: 'connections.modeKey',
  oauth: 'connections.modeSignIn',
};

/** The status words of content.md: 可用, 未连接, 已连接, 已过期 (sign in or key again), 不可用. */
function statusOf(row: Row): { word: MessageKey; tone: Tone } {
  if (!row.connector) return { word: 'connections.off', tone: 'neutral' };
  if (!row.connector.needs_connection) return { word: 'connections.ready', tone: 'success' };
  if (!row.connection) return { word: 'connections.notConnected', tone: 'neutral' };
  if (row.connection.status === 'active') return { word: 'connections.connected', tone: 'success' };
  if (row.connection.status === 'needs_reauth') return { word: 'connections.expired', tone: 'neutral' };
  return { word: 'connections.failing', tone: 'danger' };
}

function metaOf(row: Row, t: Translate): string {
  if (!row.connector) return t('connections.offHint');
  if (row.connection?.last_error && row.connection.status !== 'active') return row.connection.last_error;
  if (row.connector.builtin === 'mailbox') {
    const mailbox = row.connection?.mailbox;
    const tools = t('connections.tools', {
      count: row.connector.tool_count,
      readOnly: row.connector.read_only_tool_count,
    });
    return mailbox ? `${mailbox.address} · ${mailbox.imap.host} · ${tools}` : t('connections.mailboxMeta');
  }
  const { auth_mode, tool_count, read_only_tool_count, needs_connection } = row.connector;
  const tools = tool_count
    ? t('connections.tools', { count: tool_count, readOnly: read_only_tool_count })
    : needs_connection && !row.connection
      ? t('connections.toolsAfter')
      : t('connections.noTools');
  return `${t(MODE[auth_mode])} · ${tools}`;
}

/** Why a sign-in did not finish, in words the member can act on. */
function finishProblem(caught: unknown, t: Translate): string {
  if (caught instanceof ApiClientError) {
    if (caught.code === 'sign_in_not_yours') return t('connections.signInNotYours');
    if (caught.code === 'sign_in_expired') return t('connections.signInExpired');
    if (caught.code === 'sign_in_failed') return errorText(caught, t);
  }
  return errorText(caught, t);
}

function returnProblem(back: OAuthReturn & { kind: 'failed' }, name: string, t: Translate): string {
  if (back.error === 'access_denied') return t('connections.signInDenied', { name });
  if (back.error === 'invalid_state') return t('connections.signInExpired');
  return t('connections.signInFailed', { reason: back.description ?? back.error });
}

function KeyDialog({ connector, onClose }: { connector: AvailableConnector; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dismiss = useOverlayDraft(key, saving, onClose);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!key.trim()) return;
    setSaving(true);
    try {
      await api.me.connections.connect({ connector_id: connector.id, key: key.trim() });
      await client.invalidateQueries({ queryKey: connectorKeys.mine });
      notify(t('connections.connectedToast', { name: connector.name }));
      onClose();
    } catch (caught) {
      setSaving(false);
      const reason =
        caught instanceof ApiClientError && caught.code === 'key_rejected'
          ? ((caught.details as { reason?: string } | undefined)?.reason ?? '')
          : null;
      setError(
        reason === null
          ? errorText(caught, t)
          : reason
            ? t('connections.keyRejectedBecause', { name: connector.name, reason })
            : t('connections.keyRejected', { name: connector.name }),
      );
    }
  };
  return (
    <>
      <Overlay
        variant="dialog"
        title={t('connections.keyTitle', { name: connector.name })}
        onClose={onClose}
        beforeClose={dismiss.beforeClose}
      >
        <form {...dismiss.formProps} id="connector-key" className="app-form" onSubmit={(event) => void submit(event)}>
          {connector.key_help && <p>{connector.key_help}</p>}
          {connector.key_help_url && (
            <div>
              <Button
                kind="ghost"
                size="sm"
                onClick={() => window.open(connector.key_help_url!, '_blank', 'noopener,noreferrer')}
              >
                <ExternalLink size={icon.sm} />
                {t('connections.getKey')}
              </Button>
            </div>
          )}
          <Field
            label={t('connections.key')}
            required
            error={error || undefined}
            description={t('connections.keyHint', { name: connector.name })}
          >
            <Input
              type="password"
              autoComplete="off"
              autoFocus
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
                setError('');
              }}
            />
          </Field>
        </form>
        <OverlayActions>
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form="connector-key" loading={saving} disabled={!key.trim()}>
            {t('connections.saveKey')}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}

export function ConnectionsSection() {
  const { t } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const client = useQueryClient();
  const route = useRoute();
  const data = useMyConnections();
  const [keyFor, setKeyFor] = useState<AvailableConnector | null>(null);
  /** The mailbox dialog: open with my current connection (null for a new one). */
  const [mailboxFor, setMailboxFor] = useState<{ connection: Connection | null } | null>(null);
  const [disconnecting, setDisconnecting] = useState<Row | null>(null);
  /** The connector whose sign-in is starting: the browser is about to leave for the provider. */
  const [starting, setStarting] = useState<string | null>(null);
  const outcome = useSignInOutcome();
  const refresh = () => client.invalidateQueries({ queryKey: connectorKeys.mine });
  const nameOf = (connectorId: string | null) =>
    (data.data && rowsOf(data.data, t).find((row) => row.id === connectorId)?.name) || t('connections.thisConnector');

  // Back from a provider: finish the sign-in with my session, or say why it did not happen; then
  // take it out of the address.
  useEffect(() => {
    const back = readOAuthReturn(location.hash);
    if (!back) return;
    if (back.kind === 'failed') setSignInOutcome({ connector: back.connector, finishing: false, back });
    else if (!finishing.has(back.state)) {
      finishing.add(back.state);
      setSignInOutcome({ connector: back.connector, finishing: true });
      api.me.connections
        .finishOAuth({ state: back.state, code: back.code })
        .then((connection) => {
          setSignInOutcome(null);
          notify(t('connections.connectedToast', { name: connection.connector?.name ?? connection.display_name }));
          return client.invalidateQueries({ queryKey: connectorKeys.mine });
        })
        .catch((caught: unknown) => setSignInOutcome({ connector: back.connector, finishing: false, error: caught }));
    }
    navigate({ page: 'settings', section: 'connections' }, { replace: true });
  }, [route, t, notify, client]);

  // Leaving the page forgets how the last sign-in went.
  useEffect(
    () => () => {
      if (!location.hash.startsWith('#/settings/connections')) setSignInOutcome(null);
    },
    [],
  );

  const signIn = async (connectorId: string) => {
    setStarting(connectorId);
    setSignInOutcome(null);
    try {
      const { authorization_url } = await api.me.connections.startOAuth(connectorId);
      location.assign(authorization_url);
    } catch (caught) {
      setStarting(null);
      setSignInOutcome({ connector: connectorId, finishing: false, error: caught });
    }
  };

  const test = (row: Row) =>
    void api.me.connections
      .test(row.connection!.id)
      .then((result) => {
        if (result.ok) notify(t('connections.testOk', { name: row.name, count: result.tool_count ?? 0 }));
        return refresh();
      })
      .catch((caught: unknown) => notify(errorText(caught, t)));

  if (data.isPending) return <Skeleton lines={4} />;
  if (data.isError) return <ErrorBox onRetry={() => void data.refetch()}>{errorText(data.error, t)}</ErrorBox>;
  const rows = rowsOf(data.data, t);

  const actionFor = (row: Row) => {
    const connector = row.connector;
    if (!connector?.needs_connection) return null;
    if (row.connection && row.connection.status !== 'needs_reauth') return null;
    if (connector.builtin === 'mailbox') {
      return (
        <Button
          size="sm"
          kind={row.connection ? 'primary' : 'secondary'}
          onClick={() => setMailboxFor({ connection: row.connection })}
        >
          {row.connection ? t('connections.reconnect') : t('connections.connect')}
        </Button>
      );
    }
    const oauth = connector.auth_mode === 'oauth';
    return (
      <Button
        size="sm"
        kind={row.connection ? 'primary' : 'secondary'}
        loading={starting === row.id}
        onClick={() => (oauth ? void signIn(row.id) : setKeyFor(connector))}
      >
        {row.connection ? t('connections.reconnect') : oauth ? t('connections.signIn') : t('connections.connect')}
      </Button>
    );
  };

  const menuFor = (row: Row): MenuEntry[] => {
    if (!row.connection) return [];
    const connector = row.connector;
    const renew: MenuEntry[] =
      connector?.builtin === 'mailbox'
        ? [{ label: t('connections.mailboxChange'), onClick: () => setMailboxFor({ connection: row.connection }) }]
        : connector && row.connection.status !== 'needs_reauth'
          ? [
              {
                label: connector.auth_mode === 'oauth' ? t('connections.signInAgain') : t('connections.replaceKey'),
                onClick: () => (connector.auth_mode === 'oauth' ? void signIn(row.id) : setKeyFor(connector)),
              },
            ]
          : [];
    const others: MenuEntry[] = [
      ...(connector ? [{ label: t('connections.test'), onClick: () => test(row) }] : []),
      ...renew,
    ];
    return [
      ...others,
      ...(others.length ? (['-'] as const) : []),
      { label: t('connections.disconnect'), danger: true, onClick: () => setDisconnecting(row) },
    ];
  };

  return (
    <section className="app-section" aria-label={t('connections.connectors')}>
      <h2 className="app-section-title">{t('connections.connectors')}</h2>
      {outcome?.finishing && (
        <p className="app-muted app-inline-status" role="status">
          <Spinner size={icon.sm} />
          {t('connections.finishing', { name: nameOf(outcome.connector) })}
        </p>
      )}
      {outcome && !outcome.finishing && (
        <ErrorBox onRetry={outcome.connector ? () => void signIn(outcome.connector!) : undefined}>
          {outcome.back ? returnProblem(outcome.back, nameOf(outcome.connector), t) : finishProblem(outcome.error, t)}
        </ErrorBox>
      )}
      {rows.length ? (
        <ul className="app-list app-bordered">
          {rows.map((row) => {
            const status = statusOf(row);
            const menu = menuFor(row);
            return (
              <li key={row.id} className="app-list-row is-static">
                <span className="app-list-main">
                  <span className="app-list-title">{row.name}</span>
                  <span className="app-list-meta">{metaOf(row, t)}</span>
                </span>
                <StatusBadge status={t(status.word)} tone={status.tone} />
                {actionFor(row)}
                {menu.length > 0 && <Menu label={t('row.actionsFor', { name: row.name })} items={menu} />}
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty
          icon={<Link2 />}
          title={t('connections.none')}
          action={
            me.role === 'admin' ? (
              <Button onClick={() => navigate({ page: 'admin', section: 'connectors' })}>
                {t('connections.install')}
              </Button>
            ) : undefined
          }
        />
      )}
      {keyFor && <KeyDialog connector={keyFor} onClose={() => setKeyFor(null)} />}
      {mailboxFor && <MailboxDialog current={mailboxFor.connection} onClose={() => setMailboxFor(null)} />}
      {disconnecting && (
        <ConfirmDialog
          danger
          title={t('connections.disconnectTitle', { name: disconnecting.name })}
          confirmLabel={t('connections.disconnect')}
          onCancel={() => setDisconnecting(null)}
          onConfirm={() => {
            const target = disconnecting;
            setDisconnecting(null);
            void api.me.connections
              .remove(target.connection!.id)
              .then(() => {
                notify(t('connections.disconnected', { name: target.name }));
                return refresh();
              })
              .catch((caught: unknown) => notify(errorText(caught, t)));
          }}
        >
          {disconnecting.connector?.auth_mode === 'oauth'
            ? t('connections.disconnectBodySignIn')
            : t('connections.disconnectBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}
