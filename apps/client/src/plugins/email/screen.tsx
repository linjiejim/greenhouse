/**
 * Email (phone page; the browser place is ./screen.web.tsx): my mailboxes with their standing. +
 * adds one; a row's menu tests the connection, edits, or removes it after a confirm; adding and
 * editing swap the page for the account form. The station tests every save before storing it,
 * and the password is write-only: the form never shows a saved one.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Keyboard, Linking, RefreshControl, ScrollView, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { captureIdentity } from '../../data/identity';
import { useResource } from '../../data/use-resource';
import { useT } from '../../lib/i18n';
import { relativeTimeNow } from '../../lib/time-words';
import { makeStyles, space, typo, useTheme, weight } from '../../theme';
import { NativeButton } from '../../ui/button';
import { alertError, confirmAction } from '../../ui/dialogs';
import { EmptyState, LoadingState } from '../../ui/empty';
import { Badge, Row, Section, SectionFooter } from '../../ui/list';
import { NativeMenu, menuSections } from '../../ui/menu';
import { usePullRefresh } from '../../ui/refresh';
import { Screen } from '../../ui/screen';
import { toast } from '../../ui/toast';
import { NativeToggle } from '../../ui/toggle';
import { FormField } from '../app-form';
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
  type DraftProblem,
  type EmailAccount,
  type EmailDraft,
  type EmailPreset,
} from './model';

export function EmailScreen({ title }: { title: string }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const list = useResource(useCallback(() => listAccounts(), []));
  const presets = useResource(useCallback(() => listPresets(), []));
  const pull = usePullRefresh(list.refresh);
  const [form, setForm] = useState<'new' | EmailAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const accounts = list.data?.accounts;

  const test = async (account: EmailAccount) => {
    const current = captureIdentity();
    setBusy(account.id);
    const r = await testAccount(account.id);
    if (!current()) return;
    setBusy(null);
    if (r.ok && !testFailures(r.test).length)
      toast(t('appPages.email.testOk', { address: account.email_address }), 'checkCircle');
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
    else toast(t('appPages.email.removed'), 'trash');
    void list.refresh();
  };
  const act = (id: string, account: EmailAccount) => {
    if (id === 'test') void test(account);
    if (id === 'edit') setForm(account);
    if (id === 'remove') void remove(account);
  };

  if (form)
    return (
      <AccountForm
        account={form === 'new' ? null : form}
        presets={presets.data?.presets ?? []}
        close={() => setForm(null)}
        saved={(added) => {
          setForm(null);
          toast(t(added ? 'appPages.email.added' : 'appPages.email.saved'), 'mail');
          void list.refresh();
        }}
      />
    );

  return (
    <>
      <Screen
        title={title}
        busy={list.loading && !pull.refreshing && !!accounts}
        actions={accounts?.length ? [{ icon: 'plus', label: t('appPages.email.add'), onPress: () => setForm('new') }] : []}
      />
      <ScrollView
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        {!accounts ? (
          list.loading ? (
            <LoadingState />
          ) : list.error?.status === 403 ? (
            <EmptyState
              icon="mail"
              title={t('appPages.email.unavailable')}
              message={t('appPages.email.unavailableHint')}
              style={styles.state}
            />
          ) : (
            <EmptyState
              icon="mail"
              title={list.error?.message || t('places.pluginError')}
              onRetry={() => void list.refresh()}
              style={styles.state}
            />
          )
        ) : !accounts.length ? (
          <EmptyState
            icon="mail"
            title={t('appPages.email.empty')}
            message={t('appPages.email.emptyHint')}
            action={<NativeButton label={t('appPages.email.add')} icon="plus" onPress={() => setForm('new')} />}
            style={styles.state}
          />
        ) : (
          <Section footer={t('appPages.email.intro')}>
            {accounts.map((account) => {
              const standing = accountStanding(account);
              const name = accountTitle(account);
              return (
                <NativeMenu
                  key={account.id}
                  title={name}
                  items={menuSections([
                    [
                      { id: 'test', title: t('appPages.email.test'), icon: 'checkCircle', disabled: busy === account.id },
                      { id: 'edit', title: t('appPages.email.edit'), icon: 'pen' },
                    ],
                    [{ id: 'remove', title: t('appPages.email.remove'), icon: 'trash', destructive: true }],
                  ])}
                  onSelect={(id) => act(id, account)}
                  fill
                >
                  <Row
                    title={name}
                    subtitle={
                      (account.status === 'error' && account.error_message) ||
                      [
                        name === account.email_address ? null : account.email_address,
                        account.last_verified_at
                          ? t('appPages.email.checked', { when: relativeTimeNow(account.last_verified_at) })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') ||
                      undefined
                    }
                    icon="mail"
                    accessory={<Badge label={t(`appPages.email.status.${standing.key}`)} tone={standing.tone} />}
                    menuTrigger
                  />
                </NativeMenu>
              );
            })}
          </Section>
        )}
      </ScrollView>
    </>
  );
}

function AccountForm({
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
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const editing = !!account;
  const first = presets.find((p) => p.id !== 'custom') ?? presets[0];
  const [draft, setDraft] = useState<EmailDraft>(() => (account ? draftOf(account) : newDraft(first)));
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!account && !touched && first && !draft.imap_host) setDraft((d) => applyPreset(d, first));
  }, [account, touched, first, draft.imap_host]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preset = useMemo(() => presets.find((p) => p.id === draft.preset), [presets, draft.preset]);
  const custom = presetKey(draft.preset) === 'custom';
  const [servers, setServers] = useState(false);
  const set = (patch: Partial<EmailDraft>) => {
    setTouched(true);
    setProblem(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const submit = async () => {
    if (busy) return;
    const found = draftProblem(draft, editing);
    if (found) {
      setProblem(found);
      if (found.startsWith('imap') || found.startsWith('smtp')) setServers(true);
      return;
    }
    let body: Record<string, unknown> | null = null;
    if (account) {
      body = updateBody(account, draft);
      if (!Object.keys(body).length) return close();
    }
    Keyboard.dismiss();
    const current = captureIdentity();
    setBusy(true);
    setError(null);
    const r = account ? await updateAccount(account.id, body) : await createAccount(createBody(draft));
    if (!current()) return;
    setBusy(false);
    if (r.ok) return saved(!account);
    const lines = testFailures(r.test);
    setError(
      lines.length
        ? [t('appPages.email.testFailedSaved'), ...lines].join('\n')
        : r.message || t('appPages.email.saveFailed'),
    );
  };
  const problemText = (key: DraftProblem) => (problem === key ? t(`appPages.email.problem.${key}`) : null);
  const heading = editing ? t('appPages.email.editTitle') : t('appPages.email.addTitle');
  return (
    <>
      <Screen
        title={heading}
        busy={busy}
        actions={[
          { icon: 'x', label: t('common.cancel'), onPress: close },
          { icon: 'check', label: t('appPages.email.save'), onPress: () => void submit(), disabled: busy },
        ]}
      />
      <KeyboardAwareScrollView
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.form}
      >
        {error ? <SectionFooter text={error} style={[styles.flush, { color: c.red }]} /> : null}
        <Section variant="plain">
          <NativeMenu
            title={t('appPages.email.provider')}
            items={presets.map((p) => ({ id: p.id, title: p.label, checked: p.id === draft.preset }))}
            onSelect={(id) => {
              const next = presets.find((p) => p.id === id);
              if (!next || editing) return;
              setTouched(true);
              setDraft((d) => applyPreset(d, next));
            }}
            fill
          >
            <Row
              title={t('appPages.email.provider')}
              value={preset?.label ?? draft.preset}
              accessory={editing ? 'none' : 'chevron'}
              disabled={editing}
              menuTrigger={!editing}
            />
          </NativeMenu>
        </Section>
        <SectionFooter text={t(`appPages.email.help.${presetKey(draft.preset)}`)} style={styles.flush} />
        {preset?.help_url ? (
          <NativeButton
            label={t('appPages.email.helpLink')}
            icon="open"
            size="small"
            onPress={() => void Linking.openURL(preset.help_url!)}
          />
        ) : null}
        <FormField
          label={t('appPages.email.address')}
          value={draft.email_address}
          onChange={(email_address) => set({ email_address })}
          editable={!editing}
          keyboard="email-address"
          autoComplete="email"
          autoFocus={!editing}
          error={problemText('email')}
        />
        <FormField
          label={t('appPages.email.password')}
          value={draft.password}
          onChange={(password) => set({ password })}
          secure
          autoComplete="new-password"
          placeholder={editing ? t('appPages.email.passwordKeep') : undefined}
          hint={t('appPages.email.passwordHint')}
          error={problemText('password')}
        />
        <FormField
          label={t('appPages.email.displayName')}
          value={draft.display_name}
          onChange={(display_name) => set({ display_name })}
          placeholder={t('appPages.optional')}
        />
        <FormField
          label={t('appPages.email.username')}
          value={draft.username}
          onChange={(username) => set({ username })}
          autoComplete="username"
          placeholder={draft.email_address.trim() || t('appPages.optional')}
          hint={t('appPages.email.usernameHint')}
        />
        {custom || servers ? (
          <View style={styles.servers}>
            <SectionFooter text={t('appPages.email.servers')} style={[styles.flush, styles.heading]} />
            <FormField
              label={t('appPages.email.imapHost')}
              value={draft.imap_host}
              onChange={(imap_host) => set({ imap_host })}
              keyboard="url"
              error={problemText('imapHost')}
            />
            <FormField
              label={t('appPages.email.imapPort')}
              value={draft.imap_port}
              onChange={(imap_port) => set({ imap_port })}
              keyboard="number-pad"
              error={problemText('imapPort')}
            />
            <FormField
              label={t('appPages.email.smtpHost')}
              value={draft.smtp_host}
              onChange={(smtp_host) => set({ smtp_host })}
              keyboard="url"
              error={problemText('smtpHost')}
            />
            <FormField
              label={t('appPages.email.smtpPort')}
              value={draft.smtp_port}
              onChange={(smtp_port) => set({ smtp_port })}
              keyboard="number-pad"
              error={problemText('smtpPort')}
            />
            <NativeToggle label={t('appPages.email.tls')} value={draft.use_tls} onChange={(use_tls) => set({ use_tls })} />
            <NativeToggle
              label={t('appPages.email.proxy')}
              value={draft.use_proxy}
              onChange={(use_proxy) => set({ use_proxy })}
            />
          </View>
        ) : (
          <NativeButton label={t('appPages.email.servers')} icon="sliders" onPress={() => setServers(true)} />
        )}
      </KeyboardAwareScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl * 2 },
  state: { paddingTop: space.xxxl },
  form: { padding: space.margin, gap: space.lg, paddingBottom: space.xxxl * 2 },
  servers: { gap: space.lg },
  flush: { marginHorizontal: 0, ...typo.footnote },
  heading: { color: c.label, fontWeight: weight.semibold },
}));
