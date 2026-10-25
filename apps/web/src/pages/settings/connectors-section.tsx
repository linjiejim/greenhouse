/**
 * Settings → Connections → Connectors: the outside services my agent can use.
 *
 * - Team connectors that run on each member's own account: connect (my key,
 *   or a sign-in in a popup), test, disconnect. Team connectors that need
 *   nothing from me are just listed as ready.
 * - My personal connectors (`me/<slug>`): add, edit, switch tools, refresh,
 *   connect, delete. Only I and my agent see them.
 *
 * Hidden when my account has no `mcp_call` (the API answers 403).
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { ConnectorMemberView, ConnectorView } from '@greenhouse/types/connectors';
import { SettingsSection } from '../../components/settings';
import { Button, ConfirmDialog, IconButton, Spinner, Tag, toast } from '../../components/ui';
import { ConnectorCard } from '../../components/connectors/connector-card';
import { ConnectorFormDialog } from '../../components/connectors/connector-form-dialog';
import { ConnectorKeyDialog } from '../../components/connectors/connector-key-dialog';
import { ConnectorStatusTag } from '../../components/connectors/connector-status';
import { ConnectorToolsDialog } from '../../components/connectors/connector-tools-dialog';
import { Key, LogIn, LogOut, Pencil, Plug, Plus, RefreshCw, Trash2, Wrench } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import {
  createPersonalConnector,
  deletePersonalConnector,
  disconnectConnector,
  fetchMyConnectors,
  refreshPersonalConnector,
  startConnectorSignIn,
  testConnector,
  updatePersonalConnector,
  type MyConnectors,
} from '../../lib/api/connectors';
import { signInInPopup } from '../../lib/connector-sign-in';

type Target = { id: string; name: string; auth_kind: ConnectorMemberView['auth_kind']; status: string };

type Editing =
  | { kind: 'new' }
  | { kind: 'edit'; connector: ConnectorView }
  | { kind: 'tools'; connector: ConnectorView }
  | { kind: 'delete'; connector: ConnectorView }
  | { kind: 'key'; target: Target }
  | null;

export function ConnectorsSection() {
  const t = useT();
  const [mine, setMine] = useState<MyConnectors | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMine(await fetchMyConnectors());
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, work: () => Promise<void>) => {
    setBusy(id);
    try {
      await work();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
      await load();
    }
  };

  const connect = (target: Target) => {
    if (target.auth_kind === 'key') {
      setEditing({ kind: 'key', target });
      return;
    }
    void run(target.id, async () => {
      const outcome = await signInInPopup(target.id, () => startConnectorSignIn(target.id));
      if (outcome === 'connected') toast(t('connectors.connectedToast', { name: target.name }), 'success');
      else if (outcome === 'failed') toast(t('connectors.signInFailed'), 'error');
    });
  };

  const test = (target: Target) =>
    run(target.id, async () => {
      const result = await testConnector(target.id);
      if (result.ok) toast(t('connectors.testOk', { count: result.tool_count }), 'success');
      else toast(result.error ?? t('connectors.testFailed'), 'error');
    });

  const disconnect = (target: Target) =>
    run(target.id, async () => {
      await disconnectConnector(target.id);
      toast(t('connectors.disconnected', { name: target.name }), 'success');
    });

  /** Connect / test / disconnect for a connector that runs on my own account. */
  const connectionActions = (target: Target) => {
    const working = busy === target.id;
    const connected = target.status === 'connected' || target.status === 'error';
    return (
      <>
        {working && <Spinner className="h-3.5 w-3.5" />}
        {target.status !== 'connected' && (
          <Button size="sm" disabled={working} onClick={() => connect(target)} data-testid="connector-connect">
            {target.auth_kind === 'key' ? <Key size={14} className="mr-1" /> : <LogIn size={14} className="mr-1" />}
            {target.auth_kind === 'key'
              ? target.status === 'not_connected'
                ? t('connectors.addKey')
                : t('connectors.replaceKey')
              : target.status === 'not_connected'
                ? t('connectors.connect')
                : t('connectors.reconnect')}
          </Button>
        )}
        {connected && (
          <>
            <Button size="sm" variant="outline" disabled={working} onClick={() => void test(target)}>
              {t('connectors.test')}
            </Button>
            <Button size="sm" variant="ghost" disabled={working} onClick={() => void disconnect(target)}>
              <LogOut size={14} className="mr-1" />
              {t('connectors.disconnect')}
            </Button>
          </>
        )}
      </>
    );
  };

  if (!mine || !mine.enabled) return null;
  const perMember = mine.team.filter((c) => c.auth_mode === 'per_member');
  const ready = mine.team.filter((c) => c.auth_mode !== 'per_member');

  return (
    <>
      <SettingsSection title={t('connectors.teamSection')} description={t('connectors.teamSectionHelp')} icon={Plug}>
        {mine.team.length === 0 ? (
          <p className="text-xs text-fg-muted">{t('connectors.noTeamConnectors')}</p>
        ) : (
          <div className="space-y-2">
            {perMember.map((connector) => (
              <div
                key={connector.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-edge p-3"
                data-testid={`my-connector-${connector.slug}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-fg">{connector.name}</span>
                    <ConnectorStatusTag status={connector.status} />
                  </div>
                  {connector.description && <p className="mt-0.5 text-xs text-fg-muted">{connector.description}</p>}
                  {connector.error && <p className="mt-0.5 break-all text-xs text-danger">{connector.error}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {connectionActions({
                    id: connector.id,
                    name: connector.name,
                    auth_kind: connector.auth_kind,
                    status: connector.status,
                  })}
                </div>
              </div>
            ))}
            {ready.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs text-fg-muted">
                <span>{t('connectors.readyForYou')}</span>
                {ready.map((connector) => (
                  <Tag key={connector.id} tone="success">
                    {connector.name}
                  </Tag>
                ))}
              </div>
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('connectors.personalSection')}
        description={t('connectors.personalSectionHelp')}
        icon={Plug}
        action={
          <Button size="sm" onClick={() => setEditing({ kind: 'new' })} data-testid="personal-connector-add">
            <Plus size={14} className="mr-1" />
            {t('connectors.addConnector')}
          </Button>
        }
      >
        {mine.personal.length === 0 ? (
          <p className="text-xs text-fg-muted">{t('connectors.noPersonal')}</p>
        ) : (
          <div className="space-y-2">
            {mine.personal.map((connector) => (
              <ConnectorCard
                key={connector.id}
                connector={connector}
                actions={
                  <>
                    {connector.auth_mode === 'per_member' &&
                      connectionActions({
                        id: connector.id,
                        name: connector.name,
                        auth_kind: connector.auth_kind,
                        status: connector.status,
                      })}
                    <IconButton label={t('connectors.tools')} onClick={() => setEditing({ kind: 'tools', connector })}>
                      <Wrench size={14} />
                    </IconButton>
                    <IconButton
                      label={t('connectors.refresh')}
                      disabled={busy === connector.id}
                      onClick={() =>
                        void run(connector.id, async () => {
                          const result = await refreshPersonalConnector(connector.id);
                          if (result.ok) {
                            toast(t('connectors.refreshed', { count: result.connector.tools.length }), 'success');
                          } else toast(result.error ?? t('connectors.refreshFailed'), 'error');
                        })
                      }
                    >
                      <RefreshCw size={14} />
                    </IconButton>
                    <IconButton label={t('common.edit')} onClick={() => setEditing({ kind: 'edit', connector })}>
                      <Pencil size={14} />
                    </IconButton>
                    <IconButton
                      label={t('common.delete')}
                      variant="destructive"
                      onClick={() => setEditing({ kind: 'delete', connector })}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </>
                }
              />
            ))}
          </div>
        )}
      </SettingsSection>

      {(editing?.kind === 'new' || editing?.kind === 'edit') && (
        <ConnectorFormDialog
          scope="personal"
          existing={editing.kind === 'edit' ? editing.connector : undefined}
          onClose={() => setEditing(null)}
          onCreate={async (input) => {
            const created = await createPersonalConnector(input);
            toast(
              created.last_error
                ? t('connectors.addedWithError', { name: created.name })
                : t('connectors.added', { name: created.name, count: created.tools.length }),
              created.last_error ? 'error' : 'success',
            );
            setEditing(null);
            await load();
          }}
          onUpdate={async (id, patch) => {
            await updatePersonalConnector(id, patch);
            toast(t('connectors.saved'), 'success');
            setEditing(null);
            await load();
          }}
        />
      )}
      {editing?.kind === 'tools' && (
        <ConnectorToolsDialog
          connector={editing.connector}
          canVouch
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            await updatePersonalConnector(editing.connector.id, patch);
            toast(t('connectors.saved'), 'success');
            setEditing(null);
            await load();
          }}
        />
      )}
      {editing?.kind === 'key' && (
        <ConnectorKeyDialog
          connector={editing.target}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      <ConfirmDialog
        open={editing?.kind === 'delete'}
        onClose={() => setEditing(null)}
        onConfirm={() => {
          if (editing?.kind !== 'delete') return;
          const target = editing.connector;
          setEditing(null);
          void run(target.id, () => deletePersonalConnector(target.id));
        }}
        title={editing?.kind === 'delete' ? t('connectors.deleteTitle', { name: editing.connector.name }) : ''}
        description={t('connectors.deletePersonalBody')}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </>
  );
}
