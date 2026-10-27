/**
 * Users: every member with search, role/status filters and sorts; create (setup link or password),
 * edit nickname, account actions (password reset or link, resend/revoke the link, disable/enable,
 * delete) and the permissions dialog. Supers are shown but not edited (the station refuses).
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useResource } from '../data/use-resource';
import { useT, localeOf } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import { Icon } from '../ui/core';
import { Avatar } from '../ui/avatar';
import { confirmAction } from '../ui/dialogs';
import { toast } from '../ui/toast';
import * as admin from './api';
import { useWrite } from './use-write';
import { AdminDialog, AdminPage, Badge, Callout, Field, SectionState, type Tone } from './kit.web';
import { dayLabel, dateTimeLabel, formatTokens } from './format';
import {
  EMPTY_QUERY,
  createProblem,
  deliveryFailed,
  editable,
  linkState,
  linkUnavailable,
  statusPatch,
  visibleUsers,
  type UserQuery,
  type UserSort,
} from './users-model';
import type { ManagedUser, PasswordLinkCapability } from './types';
import { PermissionsDialog } from './permissions.web';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; user: ManagedUser }
  | { kind: 'reset'; user: ManagedUser }
  | { kind: 'permissions'; user: ManagedUser };

const STATUS_TONE: Record<string, Tone> = {
  active: 'success',
  invited: 'info',
  reset_required: 'warning',
  disabled: 'danger',
};

export default function UsersSection() {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const list = useResource(useCallback(() => admin.listUsers(), []));
  const [query, setQuery] = useState<UserQuery>(EMPTY_QUERY);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const users = list.data?.users;
  const rows = useMemo(() => visibleUsers(users ?? [], query), [users, query]);
  const capability = list.data?.password_link_capability ?? null;
  const set = <K extends keyof UserQuery>(key: K, value: UserQuery[K]) => setQuery((q) => ({ ...q, [key]: value }));
  const statusLabel = (status: string) =>
    t(
      status === 'invited'
        ? 'admin.users.statusInvited'
        : status === 'reset_required'
          ? 'admin.users.statusReset'
          : status === 'disabled'
            ? 'admin.users.statusDisabled'
            : 'admin.users.statusActive',
    );
  const sorts: { id: UserSort; label: string }[] = [
    { id: 'default', label: t('admin.users.sortDefault') },
    { id: 'month_tokens', label: t('admin.users.sortTokens') },
    { id: 'total_calls', label: t('admin.users.sortCalls') },
    { id: 'last_login', label: t('admin.users.sortLogin') },
  ];
  return (
    <AdminPage
      title={t('admin.sections.users')}
      testID="admin-users"
      actions={
        <>
          <button
            className="gh-icon-button"
            aria-label={t('common.refresh')}
            disabled={list.loading}
            onClick={() => void list.refresh()}
          >
            <Icon name="refresh" size={16} />
          </button>
          <button className="gh-primary" data-testid="admin-users-add" onClick={() => setDialog({ kind: 'create' })}>
            {t('admin.users.add')}
          </button>
        </>
      }
      toolbar={
        <>
          <input
            type="search"
            className="gh-input"
            aria-label={t('admin.users.search')}
            placeholder={t('admin.users.search')}
            value={query.search}
            onChange={(e) => set('search', e.target.value)}
            style={{ width: 220 }}
          />
          <select
            className="gh-input"
            aria-label={t('admin.users.role')}
            value={query.role}
            onChange={(e) => set('role', e.target.value as UserQuery['role'])}
          >
            <option value="">{t('admin.users.allRoles')}</option>
            <option value="super">{t('admin.users.roleSuper')}</option>
            <option value="team">{t('admin.users.roleTeam')}</option>
          </select>
          <select
            className="gh-input"
            aria-label={t('admin.users.status')}
            value={query.status}
            onChange={(e) => set('status', e.target.value as UserQuery['status'])}
          >
            <option value="">{t('admin.users.allStatuses')}</option>
            {(['active', 'invited', 'reset_required', 'disabled'] as const).map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
          <select
            className="gh-input"
            aria-label={t('admin.users.sort')}
            value={query.sort}
            onChange={(e) => set('sort', e.target.value as UserSort)}
          >
            {sorts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          {users ? (
            <span className="gh-count">
              {t('admin.users.count', { n: rows.length })}
              {rows.length !== users.length ? ` / ${users.length}` : ''}
            </span>
          ) : null}
        </>
      }
    >
      {users?.length ? (
        <table className="gh-data-grid gh-admin-grid">
          <thead>
            <tr>
              <th>{t('admin.users.name')}</th>
              <th>{t('admin.users.email')}</th>
              <th>{t('admin.users.role')}</th>
              <th>{t('admin.users.status')}</th>
              <th className="gh-number">{t('admin.users.monthTokens')}</th>
              <th className="gh-number">{t('admin.users.calls')}</th>
              <th className="gh-number">{t('admin.users.lastLogin')}</th>
              <th aria-label={t('admin.actions')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const link = linkState(u);
              return (
                <tr
                  key={u.id}
                  data-muted={u.status === 'disabled' ? '' : undefined}
                  data-open=""
                  aria-label={u.nickname}
                  onClick={() => setDialog(editable(u) ? { kind: 'edit', user: u } : { kind: 'permissions', user: u })}
                >
                  <td>
                    <span className="gh-admin-person">
                      <Avatar name={u.nickname} size={22} />
                      <strong>{u.nickname}</strong>
                    </span>
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <Badge tone={u.role === 'super' ? 'accent' : 'neutral'}>
                      {u.role === 'super' ? t('admin.users.roleSuper') : t('admin.users.roleTeam')}
                    </Badge>
                  </td>
                  <td>
                    <span className="gh-chip-row">
                      <Badge tone={STATUS_TONE[u.status] ?? 'neutral'}>{statusLabel(u.status)}</Badge>
                      {link ? (
                        <Badge
                          tone={link.kind === 'failed' ? 'danger' : 'neutral'}
                          title={u.password_link?.delivery_error ?? undefined}
                        >
                          {link.kind === 'failed'
                            ? t('admin.users.linkFailed')
                            : link.kind === 'expired'
                              ? t('admin.users.linkExpired')
                              : t('admin.users.linkExpires', { date: dateTimeLabel(link.at, localeOf(lang)) ?? '' })}
                        </Badge>
                      ) : null}
                    </span>
                  </td>
                  <td className="gh-number">{u.usage_summary ? formatTokens(u.usage_summary.month_tokens) : '—'}</td>
                  <td className="gh-number">{u.usage_summary ? u.usage_summary.total_calls.toLocaleString() : '—'}</td>
                  <td className="gh-number">{dayLabel(u.last_login_at, localeOf(lang)) ?? t('admin.users.never')}</td>
                  <td className="gh-admin-actions" onClick={(e) => e.stopPropagation()}>
                    {editable(u) ? (
                      <button
                        className="gh-icon-button"
                        aria-label={t('admin.users.editNamed', { name: u.nickname })}
                        onClick={() => setDialog({ kind: 'edit', user: u })}
                      >
                        <Icon name="pen" size={15} />
                      </button>
                    ) : null}
                    <button
                      className="gh-icon-button"
                      aria-label={t('admin.users.permissionsNamed', { name: u.nickname })}
                      onClick={() => setDialog({ kind: 'permissions', user: u })}
                    >
                      <Icon name="shieldCheck" size={15} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {!users?.length || !rows.length ? (
        users?.length ? (
          <SectionState />
        ) : (
          <SectionState
            loading={list.loading && !list.data}
            error={list.error}
            retry={() => void list.refresh()}
            icon="users"
            title={t('admin.users.empty')}
          />
        )
      ) : null}
      {dialog?.kind === 'create' ? (
        <CreateUserDialog capability={capability} close={() => setDialog(null)} done={() => void list.refresh()} />
      ) : dialog?.kind === 'edit' ? (
        <EditUserDialog
          user={dialog.user}
          capability={capability}
          close={() => setDialog(null)}
          done={() => void list.refresh()}
          resetPassword={() => setDialog({ kind: 'reset', user: dialog.user })}
          permissions={() => setDialog({ kind: 'permissions', user: dialog.user })}
        />
      ) : dialog?.kind === 'reset' ? (
        <ResetPasswordDialog
          user={dialog.user}
          capability={capability}
          close={() => setDialog(null)}
          done={() => void list.refresh()}
        />
      ) : dialog?.kind === 'permissions' ? (
        <PermissionsDialog user={dialog.user} close={() => setDialog(null)} />
      ) : null}
    </AdminPage>
  );
}

function LinkOffNote({ capability }: { capability: PasswordLinkCapability | null }) {
  const t = useT();
  const off = linkUnavailable(capability);
  return off ? <>{t(`admin.users.linkOff.${off}`)}</> : null;
}

function CreateUserDialog({
  capability,
  close,
  done,
}: {
  capability: PasswordLinkCapability | null;
  close: () => void;
  done: () => void;
}) {
  const t = useT();
  const linksOn = !linkUnavailable(capability);
  const [form, setForm] = useState({
    email: '',
    nickname: '',
    mode: (linksOn ? 'email_link' : 'direct_password') as 'email_link' | 'direct_password',
    password: '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, run } = useWrite();
  const submit = async () => {
    const issue = createProblem(form);
    if (issue) {
      setProblem(t(issue === 'required' ? 'admin.users.required' : 'admin.users.passwordShort'));
      return;
    }
    setProblem(null);
    const answer = await run(
      () =>
        admin.createUser({
          email: form.email.trim(),
          nickname: form.nickname.trim(),
          credential_mode: form.mode,
          ...(form.mode === 'direct_password' ? { password: form.password } : {}),
        }),
      t('admin.users.createFailed'),
    );
    if (!answer) return;
    toast(deliveryFailed(answer) ? t('admin.users.deliveryFailed') : t('admin.users.created'));
    done();
    close();
  };
  return (
    <AdminDialog
      title={t('admin.users.addTitle')}
      onClose={close}
      testID="admin-user-create"
      footer={
        <>
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="admin-user-create" className="gh-primary" disabled={busy}>
            {t('admin.users.create')}
          </button>
        </>
      }
    >
      <form
        id="admin-user-create"
        className="gh-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="gh-form-grid">
          <Field label={t('admin.users.email')} required>
            {(id) => (
              <input
                id={id}
                type="email"
                autoComplete="off"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('admin.users.name')} required>
            {(id) => (
              <input id={id} value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} />
            )}
          </Field>
        </div>
        <Field label={t('admin.users.credential')} help={<LinkOffNote capability={capability} />}>
          {(id) => (
            <select
              id={id}
              value={form.mode}
              onChange={(e) => setForm({ ...form, mode: e.target.value as typeof form.mode })}
            >
              <option value="email_link" disabled={!linksOn}>
                {t('admin.users.sendSetupLink')}
              </option>
              <option value="direct_password">{t('admin.users.setPassword')}</option>
            </select>
          )}
        </Field>
        {form.mode === 'direct_password' ? (
          <Field label={t('admin.users.password')} required help={t('admin.users.passwordRule')}>
            {(id) => (
              <input
                id={id}
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            )}
          </Field>
        ) : null}
        <Field label={t('admin.users.role')} help={t('admin.users.roleHint')}>
          {(id) => (
            <select id={id} value="team" disabled>
              <option value="team">{t('admin.users.roleTeam')}</option>
            </select>
          )}
        </Field>
        {problem ? (
          <p className="gh-error" role="alert">
            {problem}
          </p>
        ) : null}
      </form>
    </AdminDialog>
  );
}

function EditUserDialog({
  user,
  capability,
  close,
  done,
  resetPassword,
  permissions,
}: {
  user: ManagedUser;
  capability: PasswordLinkCapability | null;
  close: () => void;
  done: () => void;
  resetPassword: () => void;
  permissions: () => void;
}) {
  const t = useT();
  const [nickname, setNickname] = useState(user.nickname);
  // members are team; a historical account (external) converts to team here
  const [role, setRole] = useState(user.role);
  const { busy, run } = useWrite();
  const pending = user.status === 'invited' || user.status === 'reset_required';
  const save = async () => {
    const name = nickname.trim();
    if (!name) return;
    const body = {
      ...(name !== user.nickname ? { nickname: name } : {}),
      ...(role !== user.role && role === 'team' ? { role: 'team' as const } : {}),
    };
    if (!Object.keys(body).length) return close();
    if (!(await run(() => admin.updateUser(user.id, body), t('admin.users.saveFailed')))) return;
    toast(t('admin.saved'));
    done();
    close();
  };
  const account = async (action: 'resend' | 'revoke' | 'status' | 'delete') => {
    const disabling = user.status !== 'disabled';
    if (action === 'revoke') {
      const ok = await confirmAction({
        title: t('admin.users.revokeTitle', { name: user.nickname }),
        message: t('admin.users.revokeHint'),
        confirmLabel: t('admin.users.revokeLink'),
        destructive: true,
      });
      if (!ok) return;
    }
    if (action === 'status') {
      const ok = await confirmAction({
        title: t(disabling ? 'admin.users.disableTitle' : 'admin.users.enableTitle', { name: user.nickname }),
        message: disabling ? t('admin.users.disableHint') : undefined,
        confirmLabel: t(disabling ? 'admin.users.disable' : 'admin.users.enable'),
        destructive: disabling,
      });
      if (!ok) return;
    }
    if (action === 'delete') {
      const ok = await confirmAction({
        title: t('admin.users.deleteTitle', { name: user.nickname }),
        message: t('admin.users.deleteHint'),
        confirmLabel: t('admin.users.delete'),
        destructive: true,
      });
      if (!ok) return;
    }
    const answer = await run<unknown>(
      () =>
        action === 'resend'
          ? admin.resendPasswordLink(user.id)
          : action === 'revoke'
            ? admin.revokePasswordLink(user.id)
            : action === 'status'
              ? admin.updateUser(user.id, statusPatch(user))
              : admin.deleteUser(user.id),
      t('admin.users.actionFailed'),
    );
    if (!answer) return;
    toast(
      action === 'resend'
        ? deliveryFailed(answer as { delivery?: { status: 'failed'; error: string } })
          ? t('admin.users.deliveryFailed')
          : t('admin.users.linkResent')
        : action === 'revoke'
          ? t('admin.users.linkRevoked')
          : action === 'status'
            ? t(disabling ? 'admin.users.disabled' : 'admin.users.enabled')
            : t('admin.users.deleted'),
    );
    done();
    if (action !== 'resend') close();
  };
  return (
    <AdminDialog
      title={t('admin.users.editTitle', { name: user.nickname })}
      onClose={close}
      testID="admin-user-edit"
      footer={
        <>
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="admin-user-edit" className="gh-primary" disabled={busy || !nickname.trim()}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <form
        id="admin-user-edit"
        className="gh-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="gh-form-grid">
          <Field label={t('admin.users.name')} required>
            {(id) => <input id={id} value={nickname} onChange={(e) => setNickname(e.target.value)} />}
          </Field>
          <Field label={t('admin.users.email')}>{(id) => <input id={id} value={user.email} readOnly disabled />}</Field>
        </div>
        <Field label={t('admin.users.role')} help={t('admin.users.roleHint')}>
          {(id) => (
            <select id={id} value={role} disabled={user.role === 'team'} onChange={(e) => setRole(e.target.value)}>
              {user.role !== 'team' ? <option value={user.role}>{t('admin.users.roleHistorical')}</option> : null}
              <option value="team">{t('admin.users.roleTeam')}</option>
            </select>
          )}
        </Field>
        <h4 className="gh-form-heading">{t('admin.users.access')}</h4>
        <div className="gh-button-row">
          <button type="button" className="gh-secondary-button" onClick={permissions}>
            <Icon name="shieldCheck" size={14} />
            {t('admin.users.permissions')}
          </button>
        </div>
        <h4 className="gh-form-heading">{t('admin.users.account')}</h4>
        <p className="gh-hint">{t('admin.users.accountHint')}</p>
        <div className="gh-button-row">
          <button type="button" className="gh-secondary-button" disabled={busy} onClick={resetPassword}>
            <Icon name="key" size={14} />
            {t('admin.users.resetPassword')}
          </button>
          {pending ? (
            <button
              type="button"
              className="gh-secondary-button"
              disabled={busy || !!linkUnavailable(capability)}
              title={linkUnavailable(capability) ? t(`admin.users.linkOff.${linkUnavailable(capability)!}`) : undefined}
              onClick={() => void account('resend')}
            >
              <Icon name="refresh" size={14} />
              {t('admin.users.resendLink')}
            </button>
          ) : null}
          {user.password_link ? (
            <button type="button" className="gh-secondary-button" disabled={busy} onClick={() => void account('revoke')}>
              <Icon name="statusCancelled" size={14} />
              {t('admin.users.revokeLink')}
            </button>
          ) : null}
          <button type="button" className="gh-secondary-button" disabled={busy} onClick={() => void account('status')}>
            <Icon name={user.status === 'disabled' ? 'checkCircle' : 'statusCancelled'} size={14} />
            {t(user.status === 'disabled' ? 'admin.users.enable' : 'admin.users.disable')}
          </button>
          <button
            type="button"
            className="gh-secondary-button gh-danger"
            disabled={busy}
            onClick={() => void account('delete')}
          >
            <Icon name="trash" size={14} />
            {t('admin.users.delete')}
          </button>
        </div>
      </form>
    </AdminDialog>
  );
}

function ResetPasswordDialog({
  user,
  capability,
  close,
  done,
}: {
  user: ManagedUser;
  capability: PasswordLinkCapability | null;
  close: () => void;
  done: () => void;
}) {
  const t = useT();
  const linksOn = !linkUnavailable(capability);
  const [mode, setMode] = useState<'email_link' | 'direct_password'>(linksOn ? 'email_link' : 'direct_password');
  const [password, setPassword] = useState('');
  const { busy, run } = useWrite();
  const ready = mode === 'email_link' ? linksOn : password.length >= 8;
  const submit = async () => {
    if (!ready) return;
    const answer = await run(
      () => admin.resetPassword(user.id, mode === 'email_link' ? { mode } : { mode: 'direct_password', password }),
      t('admin.users.resetFailed'),
    );
    if (!answer) return;
    toast(
      mode === 'direct_password'
        ? t('admin.users.passwordSet')
        : deliveryFailed(answer)
          ? t('admin.users.deliveryFailed')
          : t('admin.users.linkSent'),
    );
    done();
    close();
  };
  return (
    <AdminDialog
      title={t('admin.users.resetTitle', { name: user.nickname })}
      size="sm"
      onClose={close}
      testID="admin-user-reset"
      footer={
        <>
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="admin-user-reset" className="gh-primary" disabled={busy || !ready}>
            {mode === 'email_link' ? t('admin.users.sendLink') : t('admin.users.setPassword')}
          </button>
        </>
      }
    >
      <form
        id="admin-user-reset"
        className="gh-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t('admin.users.resetMethod')}>
          {(id) => (
            <select id={id} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="email_link" disabled={!linksOn}>
                {t('admin.users.sendResetLink')}
              </option>
              <option value="direct_password">{t('admin.users.setPassword')}</option>
            </select>
          )}
        </Field>
        {mode === 'email_link' ? (
          <Callout icon="mail">
            {t('admin.users.resetWarning')}
            {linksOn ? null : (
              <div>
                <LinkOffNote capability={capability} />
              </div>
            )}
          </Callout>
        ) : (
          <Field label={t('admin.users.newPassword')} help={t('admin.users.passwordRule')}>
            {(id) => (
              <input
                id={id}
                type="password"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
        )}
      </form>
    </AdminDialog>
  );
}
