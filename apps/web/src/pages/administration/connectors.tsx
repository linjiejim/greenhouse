/**
 * Administration → Connectors — the team's outside services (MCP servers)
 * that agents reach through `mcp_call`.
 *
 * Add one by address (probe says how it signs in) or from the official
 * catalog; set how it authenticates (nobody / a team credential / each
 * member's own account); switch tools on and off (read-only on by default,
 * writes off until switched on, destructive ones preview first); refresh the
 * tool list; delete. Changing the address or the sign-in method drops every
 * member's credential (the server does it in one transaction).
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { ConnectorCatalogEntry, ConnectorView } from '@greenhouse/types/connectors';
import { ModulePage } from '../../components/app/module-page';
import { Button, ConfirmDialog, Dialog, EmptyState, IconButton, Spinner, Tag, toast } from '../../components/ui';
import { ConnectorCard } from '../../components/connectors/connector-card';
import { ConnectorFormDialog } from '../../components/connectors/connector-form-dialog';
import { ConnectorToolsDialog } from '../../components/connectors/connector-tools-dialog';
import { LogIn, LogOut, Pencil, Plug, Plus, RefreshCw, Trash2, Wrench, BookOpen } from '../../lib/icons';
import { useI18n, useT } from '../../lib/i18n';
import {
  clearTeamSignIn,
  createTeamConnector,
  deleteTeamConnector,
  fetchConnectorCatalog,
  fetchTeamConnectors,
  refreshTeamConnector,
  startTeamSignIn,
  updateTeamConnector,
} from '../../lib/api/connectors';
import { signInInPopup } from '../../lib/connector-sign-in';

type Editing =
  | { kind: 'new'; entry?: ConnectorCatalogEntry }
  | { kind: 'edit'; connector: ConnectorView }
  | { kind: 'tools'; connector: ConnectorView }
  | { kind: 'delete'; connector: ConnectorView }
  | null;

export function ConnectorsAdminPanel() {
  const t = useT();
  const [connectors, setConnectors] = useState<ConnectorView[] | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setConnectors(await fetchTeamConnectors());
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      setConnectors([]);
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

  const refresh = (connector: ConnectorView) =>
    run(connector.id, async () => {
      const result = await refreshTeamConnector(connector.id);
      if (result.ok) toast(t('connectors.refreshed', { count: result.connector.tools.length }), 'success');
      else toast(result.error ?? t('connectors.refreshFailed'), 'error');
    });

  const teamSignIn = (connector: ConnectorView) =>
    run(connector.id, async () => {
      const outcome = await signInInPopup(connector.id, () => startTeamSignIn(connector.id));
      if (outcome === 'connected') toast(t('connectors.connectedToast', { name: connector.name }), 'success');
      else if (outcome === 'failed') toast(t('connectors.signInFailed'), 'error');
    });

  const actions = (connector: ConnectorView) => {
    const working = busy === connector.id;
    const teamOAuth = connector.auth_mode === 'shared' && connector.auth_kind === 'oauth';
    return (
      <>
        {working && <Spinner className="h-3.5 w-3.5" />}
        {teamOAuth &&
          (connector.has_shared_secret ? (
            <Button
              size="sm"
              variant="outline"
              disabled={working}
              onClick={() => run(connector.id, async () => void (await clearTeamSignIn(connector.id)))}
            >
              <LogOut size={14} className="mr-1" />
              {t('connectors.teamSignOut')}
            </Button>
          ) : (
            <Button size="sm" disabled={working} onClick={() => teamSignIn(connector)}>
              <LogIn size={14} className="mr-1" />
              {t('connectors.teamSignIn')}
            </Button>
          ))}
        <IconButton
          label={t('connectors.tools')}
          disabled={working}
          onClick={() => setEditing({ kind: 'tools', connector })}
        >
          <Wrench size={14} />
        </IconButton>
        <IconButton label={t('connectors.refresh')} disabled={working} onClick={() => void refresh(connector)}>
          <RefreshCw size={14} />
        </IconButton>
        <IconButton label={t('common.edit')} disabled={working} onClick={() => setEditing({ kind: 'edit', connector })}>
          <Pencil size={14} />
        </IconButton>
        <IconButton
          variant="destructive"
          label={t('common.delete')}
          disabled={working}
          onClick={() => setEditing({ kind: 'delete', connector })}
        >
          <Trash2 size={14} />
        </IconButton>
      </>
    );
  };

  return (
    <ModulePage
      moduleId="admin.connectors"
      layout="list"
      actions={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setCatalogOpen(true)} data-testid="connectors-catalog">
            <BookOpen size={14} className="mr-1" />
            {t('connectors.fromCatalog')}
          </Button>
          <Button size="sm" onClick={() => setEditing({ kind: 'new' })} data-testid="connectors-add">
            <Plus size={14} className="mr-1" />
            {t('connectors.addConnector')}
          </Button>
        </div>
      }
    >
      <p className="mb-4 text-xs text-fg-muted">{t('connectors.adminIntro')}</p>
      {connectors === null ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-5 w-5" />
        </div>
      ) : connectors.length === 0 ? (
        <EmptyState icon={Plug} title={t('connectors.emptyTeam')} description={t('connectors.emptyTeamHint')} />
      ) : (
        <div className="space-y-3">
          {connectors.map((connector) => (
            <ConnectorCard key={connector.id} connector={connector} actions={actions(connector)} showConnections />
          ))}
        </div>
      )}

      {catalogOpen && (
        <CatalogDialog
          onClose={() => setCatalogOpen(false)}
          onPick={(entry) => {
            setCatalogOpen(false);
            setEditing({ kind: 'new', entry });
          }}
        />
      )}
      {(editing?.kind === 'new' || editing?.kind === 'edit') && (
        <ConnectorFormDialog
          scope="team"
          existing={editing.kind === 'edit' ? editing.connector : undefined}
          catalogEntry={editing.kind === 'new' ? editing.entry : undefined}
          onClose={() => setEditing(null)}
          onCreate={async (input) => {
            const created = await createTeamConnector(input);
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
            await updateTeamConnector(id, patch);
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
            await updateTeamConnector(editing.connector.id, patch);
            toast(t('connectors.saved'), 'success');
            setEditing(null);
            await load();
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
          void run(target.id, () => deleteTeamConnector(target.id));
        }}
        title={editing?.kind === 'delete' ? t('connectors.deleteTitle', { name: editing.connector.name }) : ''}
        description={t('connectors.deleteBody')}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </ModulePage>
  );
}

function CatalogDialog({ onClose, onPick }: { onClose: () => void; onPick: (entry: ConnectorCatalogEntry) => void }) {
  const t = useT();
  const { locale } = useI18n();
  const zh = locale === 'zh';
  const [entries, setEntries] = useState<ConnectorCatalogEntry[] | null>(null);

  useEffect(() => {
    void fetchConnectorCatalog()
      .then(setEntries)
      .catch((err: unknown) => {
        toast(err instanceof Error ? err.message : String(err), 'error');
        setEntries([]);
      });
  }, []);

  return (
    <Dialog open onClose={onClose} title={t('connectors.catalogTitle')} size="lg">
      <div className="space-y-3" data-testid="connector-catalog">
        <p className="text-xs text-fg-muted">{t('connectors.catalogHelp')}</p>
        {entries === null ? (
          <div className="flex justify-center py-6">
            <Spinner className="h-5 w-5" />
          </div>
        ) : (
          <ul className="divide-y divide-edge rounded-lg border border-edge">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-fg">{(zh ? entry.title_zh : null) ?? entry.title}</span>
                    <Tag tone="info">{t(`connectors.authMode.${entry.auth.mode}`)}</Tag>
                    {entry.auth.kind && entry.auth.mode !== 'none' && (
                      <Tag tone="neutral">{t(`connectors.authKind.${entry.auth.kind}`)}</Tag>
                    )}
                    {entry.installed_slug && <Tag tone="success">{t('connectors.installed')}</Tag>}
                  </div>
                  <p className="mt-1 text-xs text-fg-muted">{zh ? entry.description_zh : entry.description}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(entry.installed_slug)}
                  onClick={() => onPick(entry)}
                  data-testid={`catalog-add-${entry.slug}`}
                >
                  {t('connectors.add')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
