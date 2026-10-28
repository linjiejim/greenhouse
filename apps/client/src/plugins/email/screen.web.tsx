/**
 * Email (browser place): my mailboxes with their standing. Add opens the account dialog (provider,
 * address, app password; servers prefilled from the station's presets); a row opens it to edit;
 * its menu tests the connection or removes the mailbox after a confirm. The station tests every
 * save before storing it, and the password is write-only: the dialog never shows a saved one.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { captureIdentity } from '../../data/identity';
import { useResource } from '../../data/use-resource';
import { useT } from '../../lib/i18n';
import { relativeTimeNow } from '../../lib/time-words';
import { Icon } from '../../ui/core';
import { alertError, confirmAction } from '../../ui/dialogs';
import { NativeMenu, menuSections } from '../../ui/menu.web';
import { DialogBody, Overlay } from '../../ui/overlay.web';
import { Place, PlaceEmpty } from '../../ui/place.web';
import { toast } from '../../ui/toast';
import { createAccount, listAccounts, listPresets, removeAccount, testAccount, updateAccount } from './api';
import {
  accountStanding,
  accountTitle,
  applyPreset,
  createBody,
  draftOf,
  draftProblem,
  newDraft,
  presetKey,
  testFailures,
  updateBody,
  type EmailAccount,
  type EmailDraft,
  type EmailPreset,
} from './model';
import '../app-pages.css';

const TONE = { green: 'success', red: 'danger', neutral: 'neutral' } as const;

export function EmailScreen({ title }: { title: string }) {
  const t = useT();
  const list = useResource(useCallback(() => listAccounts(), []));
  const presets = useResource(useCallback(() => listPresets(), []));
  // `null` closed, 'new' adding, else the account being edited
  const [dialog, setDialog] = useState<'new' | EmailAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => void list.refresh();
    window.addEventListener('greenhouse:refresh', refresh);
    return () => window.removeEventListener('greenhouse:refresh', refresh);
  });
  const accounts = list.data?.accounts;

  const test = async (account: EmailAccount) => {
    const current = captureIdentity();
    setBusy(account.id);
    const r = await testAccount(account.id);
    if (!current()) return;
    setBusy(null);
    if (r.ok && !testFailures(r.test).length) toast(t('appPages.email.testOk', { address: account.email_address }));
    else
      alertError(
        t('appPages.email.testBroken', { address: account.email_address }),
        r.ok ? undefined : r.message,
        // the provider's own words are technical: behind Details
        r.ok ? testFailures(r.test).join('\n') : undefined,
      );
    void list.refresh();
  };
  const remove = async (account: EmailAccount) => {
    const current = captureIdentity();
    const ok = await confirmAction({
      title: t('appPages.email.removeTitle', { address: account.email_address }),
      message: t('appPages.email.removeHint'),
      confirmLabel: t('appPages.email.remove'),
      destructive: true,
    });
    if (!ok || !current()) return;
    setBusy(account.id);
    const r = await removeAccount(account.id);
    if (!current()) return;
    setBusy(null);
    if (!r.ok) alertError(t('appPages.email.removeFailed'), r.message);
    else toast(t('appPages.email.removed'));
    void list.refresh();
  };
  const act = (id: string, account: EmailAccount) => {
    if (id === 'test') void test(account);
    if (id === 'edit') setDialog(account);
    if (id === 'remove') void remove(account);
  };
  const add = (
    <button className="gh-primary" onClick={() => setDialog('new')}>
      <Icon name="plus" size={16} color="currentColor" />
      {t('appPages.email.add')}
    </button>
  );

  return (
    <Place
      title={title}
      actions={
        <>
          <button onClick={() => void list.refresh()} disabled={list.loading} aria-label={t('common.refresh')}>
            <Icon name="refresh" size={16} />
          </button>
          {accounts?.length ? add : null}
        </>
      }
    >
      <div className="gh-place-scroll">
        {!accounts ? (
          list.error?.status === 403 ? (
            <PlaceEmpty icon="mail" title={t('appPages.email.unavailable')} message={t('appPages.email.unavailableHint')} />
          ) : (
            <PlaceEmpty
              loading={list.loading}
              error={list.error ? list.error.message || t('places.pluginError') : null}
              retry={() => void list.refresh()}
            />
          )
        ) : !accounts.length ? (
          <PlaceEmpty icon="mail" title={t('appPages.email.empty')} message={t('appPages.email.emptyHint')} action={add} />
        ) : (
          <div className="gh-app-page" data-testid="email-page">
            <p className="gh-hint">{t('appPages.email.intro')}</p>
            <ul className="gh-resource-list" data-testid="email-accounts">
              {accounts.map((account) => {
                const standing = accountStanding(account);
                const name = accountTitle(account);
                return (
                  <li key={account.id} aria-busy={busy === account.id || undefined}>
                    <button className="gh-app-row-main" aria-label={name} onClick={() => setDialog(account)}>
                      <span className="gh-resource-icon">
                        <Icon name="mail" size={18} color="var(--gh-accent-text)" />
                      </span>
                      <span className="gh-resource-body">
                        <strong>{name}</strong>
                        <p>
                          {[name === account.email_address ? null : account.email_address, account.imap_host]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                        {account.status === 'error' && account.error_message ? (
                          <p className="gh-error gh-app-row-error">{account.error_message}</p>
                        ) : null}
                      </span>
                    </button>
                    <div className="gh-resource-meta">
                      <span className="gh-badge" data-tone={TONE[standing.tone]}>
                        {t(`appPages.email.status.${standing.key}`)}
                      </span>
                      {account.last_verified_at ? (
                        <small>{t('appPages.email.checked', { when: relativeTimeNow(account.last_verified_at) })}</small>
                      ) : null}
                    </div>
                    <NativeMenu
                      title={name}
                      items={menuSections([
                        [
                          { id: 'test', title: t('appPages.email.test'), icon: 'checkCircle' },
                          { id: 'edit', title: t('appPages.email.edit'), icon: 'pen' },
                        ],
                        [{ id: 'remove', title: t('appPages.email.remove'), icon: 'trash', destructive: true }],
                      ])}
                      onSelect={(id) => act(id, account)}
                    >
                      <button
                        className="gh-icon-button"
                        disabled={busy === account.id}
                        aria-label={t('appPages.actionsFor', { name })}
                      >
                        <Icon name="more" size={16} />
                      </button>
                    </NativeMenu>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
      {dialog ? (
        <AccountDialog
          account={dialog === 'new' ? null : dialog}
          presets={presets.data?.presets ?? []}
          close={() => setDialog(null)}
          saved={(added) => {
            setDialog(null);
            toast(t(added ? 'appPages.email.added' : 'appPages.email.saved'));
            void list.refresh();
          }}
        />
      ) : null}
    </Place>
  );
}

function AccountDialog({
  account,
  presets,
  close,
  saved,
}: {
  account: EmailAccount | null;
  presets: EmailPreset[];
  close: () => void;
  saved: (added: boolean) => void;
}) {
  const t = useT();
  const editing = !!account;
  const [draft, setDraft] = useState<EmailDraft>(() =>
    account ? draftOf(account) : newDraft(presets.find((p) => p.id !== 'custom') ?? presets[0]),
  );
  // presets may answer after the dialog opened: a fresh draft takes the first one then
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!account && !touched && presets.length && !draft.imap_host)
      setDraft((d) => applyPreset(d, presets.find((p) => p.id !== 'custom') ?? presets[0]!));
  }, [account, touched, presets, draft.imap_host]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; lines: string[] } | null>(null);
  const set = (patch: Partial<EmailDraft>) => {
    setTouched(true);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const preset = useMemo(() => presets.find((p) => p.id === draft.preset), [presets, draft.preset]);
  const custom = presetKey(draft.preset) === 'custom';
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const problem = draftProblem(draft, editing);
    if (problem) {
      setError({ message: t(`appPages.email.problem.${problem}`), lines: [] });
      return;
    }
    let body: Record<string, unknown> | null = null;
    if (account) {
      body = updateBody(account, draft);
      if (!Object.keys(body).length) return close();
    }
    const current = captureIdentity();
    setBusy(true);
    setError(null);
    const r = account ? await updateAccount(account.id, body) : await createAccount(createBody(draft));
    if (!current()) return;
    setBusy(false);
    if (r.ok) return saved(!account);
    const lines = testFailures(r.test);
    setError({ message: lines.length ? t('appPages.email.testFailedSaved') : r.message || t('appPages.email.saveFailed'), lines });
  };
  const field = (key: keyof EmailDraft, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="gh-field">
      <label htmlFor={`email-${key}`}>{label}</label>
      <input
        id={`email-${key}`}
        value={String(draft[key])}
        onChange={(e) => set({ [key]: e.target.value } as Partial<EmailDraft>)}
        autoComplete="off"
        spellCheck={false}
        {...extra}
      />
    </div>
  );
  const servers = (
    <fieldset className="gh-form-section">
      <div className="gh-form-grid">
        {field('imap_host', t('appPages.email.imapHost'))}
        {field('imap_port', t('appPages.email.imapPort'), { inputMode: 'numeric' })}
        {field('smtp_host', t('appPages.email.smtpHost'))}
        {field('smtp_port', t('appPages.email.smtpPort'), { inputMode: 'numeric' })}
      </div>
      <label className="gh-check">
        <input type="checkbox" checked={draft.use_tls} onChange={(e) => set({ use_tls: e.target.checked })} />
        <span>{t('appPages.email.tls')}</span>
      </label>
      <label className="gh-check">
        <input type="checkbox" checked={draft.use_proxy} onChange={(e) => set({ use_proxy: e.target.checked })} />
        <span>{t('appPages.email.proxy')}</span>
      </label>
    </fieldset>
  );
  const heading = editing ? t('appPages.email.editTitle') : t('appPages.email.addTitle');
  return (
    <Overlay label={heading} onClose={close} testID="email-account" size="lg">
      <form
        className="gh-dialog-form"
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
        }}
      >
        <DialogBody
          title={heading}
          actions={
            <button type="button" className="gh-icon-button" aria-label={t('common.close')} onClick={close}>
              <Icon name="x" size={18} />
            </button>
          }
          footer={
            <>
              <button type="button" className="gh-secondary-button" onClick={close}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="gh-primary" disabled={busy}>
                {busy ? t('appPages.email.saving') : t('appPages.email.save')}
              </button>
            </>
          }
        >
          <div className="gh-form">
            <div className="gh-form-grid">
              <div className="gh-field">
                <label htmlFor="email-preset">{t('appPages.email.provider')}</label>
                <select
                  id="email-preset"
                  value={draft.preset}
                  disabled={editing}
                  onChange={(e) => {
                    const next = presets.find((p) => p.id === e.target.value);
                    if (next) {
                      setTouched(true);
                      setDraft((d) => applyPreset(d, next));
                    }
                  }}
                >
                  {(presets.length ? presets : [{ id: draft.preset, label: draft.preset }]).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              {field('email_address', t('appPages.email.address'), {
                type: 'email',
                disabled: editing,
                autoComplete: 'email',
                autoFocus: !editing,
              })}
            </div>
            <p className="gh-hint">
              {t(`appPages.email.help.${presetKey(draft.preset)}`)}{' '}
              {preset?.help_url ? (
                <a href={preset.help_url} target="_blank" rel="noreferrer">
                  {t('appPages.email.helpLink')}
                </a>
              ) : null}
            </p>
            <div className="gh-field">
              <label htmlFor="email-password">{t('appPages.email.password')}</label>
              <input
                id="email-password"
                type="password"
                value={draft.password}
                onChange={(e) => set({ password: e.target.value })}
                autoComplete="new-password"
                placeholder={editing ? t('appPages.email.passwordKeep') : undefined}
              />
              <p className="gh-hint">{t('appPages.email.passwordHint')}</p>
            </div>
            <div className="gh-form-grid">
              {field('display_name', t('appPages.email.displayName'), { placeholder: t('appPages.optional') })}
              <div className="gh-field">
                <label htmlFor="email-username">{t('appPages.email.username')}</label>
                <input
                  id="email-username"
                  value={draft.username}
                  onChange={(e) => set({ username: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={draft.email_address.trim() || t('appPages.optional')}
                />
                <p className="gh-hint">{t('appPages.email.usernameHint')}</p>
              </div>
            </div>
            {custom ? (
              <>
                <p className="gh-form-heading">{t('appPages.email.servers')}</p>
                {servers}
              </>
            ) : (
              <details>
                <summary>{t('appPages.email.servers')}</summary>
                {servers}
              </details>
            )}
            {error ? (
              <div role="alert" className="gh-callout" data-tone="danger">
                <Icon name="alertCircle" size={16} color="var(--gh-danger)" />
                <div className="gh-callout-text">
                  {error.message}
                  {error.lines.map((line) => (
                    <small key={line}>{line}</small>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </DialogBody>
      </form>
    </Overlay>
  );
}
