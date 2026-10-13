/**
 * 管理 → 外部访问 (ADM-09): the clients that reach /api/mcp. Interactive clients sign members in
 * through the consent page (registered by themselves, or added here with fixed callback
 * addresses and an optional cap on what members may grant); machine clients hold a secret and
 * act for one member once that member approves. Disabling ends every token at once; a secret
 * shows once, on creation and on rotation.
 */

import { useState, type FormEvent } from 'react';
import { Plus, Shield } from 'lucide-react';
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
  Segmented,
  Select,
  Skeleton,
  StatusBadge,
  TextArea,
  type MenuEntry,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { OAUTH_SCOPES, type AdminClient, type CreateClientInput, type OAuthScope } from '@greenhouse/contract';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { accessKeys, useClients } from '../../data/access';
import type { MessageKey } from '../../i18n/zh';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n, type Translate } from '../../lib/i18n';
import { relativeTime } from '../../lib/time';
import { ScopeChecks } from '../access/scopes';
import { ShownOnce } from '../access/ShownOnce';

type Kind = AdminClient['kind'];

const BOUND: Record<NonNullable<AdminClient['bound_grant_status']>, MessageKey> = {
  pending: 'clients.boundPending',
  active: 'clients.boundActive',
  revoked: 'clients.boundRevoked',
};

/** Who a client acts for: a machine client's member and whether they approved; else how many members authorized it. */
function actsFor(client: AdminClient, t: Translate): string {
  if (client.kind === 'machine' && client.bound_member) {
    return t(BOUND[client.bound_grant_status ?? 'pending'], { name: client.bound_member.name });
  }
  return t('clients.grants', { count: client.active_grants });
}

/** A secret or an id to hand over, shown once. */
interface Handover {
  title: string;
  fields: { label: string; value: string }[];
  note: string;
}

function ClientDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (handover: Handover) => void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const directory = useQuery({ queryKey: ['members', 'directory'], queryFn: () => api.members.directory() });
  const [kind, setKind] = useState<Kind>('interactive');
  const [name, setName] = useState('');
  const [uris, setUris] = useState('');
  const [member, setMember] = useState('');
  const [scopes, setScopes] = useState<OAuthScope[]>([...OAUTH_SCOPES]);
  const [error, setError] = useState<{ field: 'name' | 'uris' | 'member' | 'scopes'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const redirects = uris
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (kind === 'interactive' && !redirects.length) return setError({ field: 'uris', text: t('clients.needUris') });
    if (kind === 'machine' && !member) return setError({ field: 'member', text: t('clients.needMember') });
    if (!scopes.length) return setError({ field: 'scopes', text: t('access.pickScope') });
    const input: CreateClientInput =
      kind === 'interactive'
        ? {
            kind,
            name: name.trim(),
            redirect_uris: redirects,
            // Every scope ticked is no cap at all (new scopes included).
            ...(scopes.length < OAUTH_SCOPES.length ? { scopes } : {}),
          }
        : { kind, name: name.trim(), member_id: member, scopes };
    setSaving(true);
    try {
      const created = await api.admin.clients.create(input);
      await client.invalidateQueries({ queryKey: accessKeys.clients });
      onClose();
      onCreated({
        title: t('clients.createdTitle', { name: created.client.name }),
        fields: [
          { label: t('clients.clientId'), value: created.client.id },
          ...(created.client_secret ? [{ label: t('clients.secret'), value: created.client_secret }] : []),
        ],
        note: created.client_secret ? t('clients.secretOnce') : t('clients.interactiveNote'),
      });
    } catch (caught) {
      setSaving(false);
      // What the server refuses is the callback addresses, or the member it would act for.
      setError({ field: kind === 'interactive' ? 'uris' : 'member', text: errorText(caught, t) });
    }
  };
  const errorOf = (field: 'name' | 'uris' | 'member' | 'scopes') => (error?.field === field ? error.text : undefined);
  return (
    <Overlay variant="dialog" wide title={t('clients.add')} onClose={onClose}>
      <form id="oauth-client" className="app-form" onSubmit={(event) => void submit(event)}>
        <FieldGroup
          label={t('clients.kind')}
          description={kind === 'interactive' ? t('clients.interactiveHint') : t('clients.machineHint')}
        >
          <Segmented
            label={t('clients.kind')}
            items={[
              { value: 'interactive', label: t('clients.kind.interactive') },
              { value: 'machine', label: t('clients.kind.machine') },
            ]}
            value={kind}
            onChange={(value) => {
              setKind(value as Kind);
              setError(null);
            }}
          />
        </FieldGroup>
        <Field label={t('clients.name')} required error={errorOf('name')}>
          <Input
            value={name}
            maxLength={120}
            autoFocus
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
        </Field>
        {kind === 'interactive' ? (
          <Field
            label={t('clients.redirectUris')}
            required
            description={t('clients.redirectUrisHint')}
            error={errorOf('uris')}
          >
            <TextArea
              value={uris}
              maxRows={6}
              placeholder="https://app.example.com/callback"
              onChange={(event) => {
                setUris(event.target.value);
                setError(null);
              }}
            />
          </Field>
        ) : (
          <Field label={t('clients.member')} required description={t('clients.memberHint')} error={errorOf('member')}>
            <Select
              label={t('clients.member')}
              value={member}
              options={(directory.data?.items ?? []).map((item) => ({
                value: item.id,
                label: item.name,
                description: item.email,
              }))}
              onChange={(value) => {
                setMember(value);
                setError(null);
              }}
            />
          </Field>
        )}
        <ScopeChecks
          label={kind === 'interactive' ? t('clients.scopeCap') : t('clients.scopes')}
          value={scopes}
          error={errorOf('scopes')}
          onChange={(next) => {
            setScopes(next);
            setError(null);
          }}
        />
      </form>
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button kind="primary" type="submit" form="oauth-client" loading={saving} disabled={!name.trim()}>
          {t('clients.add')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}

function RenameDialog({ client: target, onClose }: { client: AdminClient; onClose: () => void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [name, setName] = useState(target.name);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.admin.clients.update(target.id, { name: name.trim() });
      await client.invalidateQueries({ queryKey: accessKeys.clients });
      onClose();
    } catch (caught) {
      setSaving(false);
      setError(errorText(caught, t));
    }
  };
  return (
    <Overlay variant="dialog" title={t('clients.rename')} onClose={onClose}>
      <form id="oauth-client-name" className="app-form" onSubmit={(event) => void submit(event)}>
        <Field label={t('clients.name')} required error={error || undefined}>
          <Input value={name} maxLength={120} autoFocus onChange={(event) => setName(event.target.value)} />
        </Field>
      </form>
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button kind="primary" type="submit" form="oauth-client-name" loading={saving} disabled={!name.trim()}>
          {t('common.save')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}

type Confirming = { action: 'disable' | 'rotate' | 'delete'; client: AdminClient };

export function ClientsSection() {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const client = useQueryClient();
  const clients = useClients();
  const [adding, setAdding] = useState(false);
  const [handover, setHandover] = useState<Handover | null>(null);
  const [renaming, setRenaming] = useState<AdminClient | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const items = clients.data?.pages.flatMap((page) => page.items) ?? [];
  const refresh = () => client.invalidateQueries({ queryKey: accessKeys.clients });
  const failed = (caught: unknown) => notify(errorText(caught, t));

  const run = ({ action, client: target }: Confirming) => {
    if (action === 'disable')
      void api.admin.clients
        .update(target.id, { status: 'disabled' })
        .then(() => {
          notify(t('clients.disabled', { name: target.name }));
          return refresh();
        })
        .catch(failed);
    else if (action === 'rotate')
      void api.admin.clients
        .rotateSecret(target.id)
        .then((rotated) => {
          setHandover({
            title: t('clients.rotatedTitle', { name: rotated.client.name }),
            fields: [
              { label: t('clients.clientId'), value: rotated.client.id },
              { label: t('clients.secret'), value: rotated.client_secret },
            ],
            note: t('clients.secretOnce'),
          });
          return refresh();
        })
        .catch(failed);
    else
      void api.admin.clients
        .remove(target.id)
        .then(() => {
          notify(t('clients.deleted', { name: target.name }));
          return refresh();
        })
        .catch(failed);
  };

  const menuFor = (item: AdminClient): MenuEntry[] => [
    { label: t('clients.rename'), onClick: () => setRenaming(item) },
    ...(item.kind === 'machine'
      ? [{ label: t('clients.rotate'), onClick: () => setConfirming({ action: 'rotate', client: item }) }]
      : []),
    item.status === 'active'
      ? { label: t('clients.disable'), onClick: () => setConfirming({ action: 'disable', client: item }) }
      : {
          label: t('clients.enable'),
          onClick: () =>
            void api.admin.clients
              .update(item.id, { status: 'active' })
              .then(() => refresh())
              .catch(failed),
        },
    '-',
    { label: t('row.delete'), danger: true, onClick: () => setConfirming({ action: 'delete', client: item }) },
  ];

  const CONFIRM: Record<Confirming['action'], { title: MessageKey; body: MessageKey; label: MessageKey }> = {
    disable: { title: 'clients.disableTitle', body: 'clients.disableBody', label: 'clients.disable' },
    rotate: { title: 'clients.rotateTitle', body: 'clients.rotateBody', label: 'clients.rotate' },
    delete: { title: 'clients.deleteTitle', body: 'clients.deleteBody', label: 'row.delete' },
  };

  return (
    <section className="app-section">
      <div className="app-section-heading">
        <h2 className="app-section-title">{t('clients.count', { count: items.length })}</h2>
        <Button kind="primary" onClick={() => setAdding(true)}>
          <Plus size={icon.md} />
          {t('clients.add')}
        </Button>
      </div>
      {clients.isPending ? (
        <Skeleton lines={4} />
      ) : clients.isError ? (
        <ErrorBox onRetry={() => void clients.refetch()}>{t('common.error')}</ErrorBox>
      ) : items.length ? (
        <div className="app-table-wrap">
          <table className="app-table" aria-label={t('admin.access')}>
            <thead>
              <tr>
                <th>{t('clients.name')}</th>
                <th>{t('clients.actsFor')}</th>
                <th className="is-number">{t('clients.tokens')}</th>
                <th>{t('clients.lastUsed')}</th>
                <th>{t('clients.status')}</th>
                <th>
                  <span className="app-sr-only">{t('clients.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="app-cell-stack">
                      <span>{item.name}</span>
                      <span className="app-muted">
                        {t(item.kind === 'machine' ? 'clients.kind.machine' : 'clients.kind.interactive')} ·{' '}
                        {t(item.registration === 'dynamic' ? 'clients.dynamic' : 'clients.byAdmin')}
                      </span>
                    </span>
                  </td>
                  <td>{actsFor(item, t)}</td>
                  <td className="is-number">{item.active_tokens}</td>
                  <td>
                    {item.last_used_at
                      ? relativeTime(item.last_used_at, { locale, timeZone: me.timezone })
                      : t('clients.never')}
                  </td>
                  <td>
                    {item.status === 'active' ? (
                      <StatusBadge status={t('clients.active')} tone="success" />
                    ) : (
                      <StatusBadge status={t('clients.off')} tone="neutral" />
                    )}
                  </td>
                  <td>
                    <Menu label={t('row.actionsFor', { name: item.name })} items={menuFor(item)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon={<Shield />} title={t('clients.none')} />
      )}
      {clients.hasNextPage && (
        <div>
          <Button loading={clients.isFetchingNextPage} onClick={() => void clients.fetchNextPage()}>
            {t('clients.more')}
          </Button>
        </div>
      )}
      {adding && <ClientDialog onClose={() => setAdding(false)} onCreated={setHandover} />}
      {handover && (
        <ShownOnce title={handover.title} fields={handover.fields} onClose={() => setHandover(null)}>
          {handover.note}
        </ShownOnce>
      )}
      {renaming && <RenameDialog client={renaming} onClose={() => setRenaming(null)} />}
      {confirming && (
        <ConfirmDialog
          danger
          title={t(CONFIRM[confirming.action].title, { name: confirming.client.name })}
          confirmLabel={t(CONFIRM[confirming.action].label)}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const target = confirming;
            setConfirming(null);
            run(target);
          }}
        >
          {t(CONFIRM[confirming.action].body, { count: confirming.client.active_grants })}
        </ConfirmDialog>
      )}
    </section>
  );
}
