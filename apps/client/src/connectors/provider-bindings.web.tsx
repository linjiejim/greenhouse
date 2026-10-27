/**
 * Linked accounts on Me → Connections in the browser: one row per identity provider the station
 * offers for binding (the manifest's `identityProviders` with plugin glue here,
 * src/plugins/identity.ts), each with its standing (`GET <path>/binding`). Link opens the
 * provider (`GET <path>/oauth/start`, which knows who is linking from the session) and returns to
 * `/bindings`; Unlink asks first. A provider the station has not configured shows nothing.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { readBinding, removeBinding, startBinding, type ProviderBinding } from '../api/entry';
import { captureIdentity } from '../data/identity';
import { useT } from '../lib/i18n';
import { bindingProviders, type IdentityGlue } from '../plugins/identity';
import { identityGlue } from '../plugins/identity-registry';
import { useStationManifest } from '../plugins/store';
import { NativeButton } from '../ui/button';
import { alertError, confirmAction } from '../ui/dialogs';
import { Row, Section } from '../ui/list';
import { toast } from '../ui/toast';

export function ProviderBindings() {
  const t = useT();
  const manifest = useStationManifest((s) => s.data);
  const providers = useMemo(
    () => bindingProviders(identityGlue, manifest.kind === 'v2' ? manifest.manifest.identityProviders : undefined),
    [manifest],
  );
  const [standing, setStanding] = useState<Record<string, ProviderBinding | null>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const current = captureIdentity();
    const answers = await Promise.all(
      providers.map(async (provider) => {
        const result = await readBinding(provider.path);
        return [provider.id, result.ok ? result.data : null] as const;
      }),
    );
    if (current()) setStanding(Object.fromEntries(answers));
  }, [providers]);
  useEffect(() => {
    void load();
  }, [load]);

  const link = async (provider: IdentityGlue) => {
    setBusy(provider.id);
    const started = await startBinding(provider.path);
    if (started.ok && typeof started.data.authorize_url === 'string') {
      window.location.assign(started.data.authorize_url);
      return;
    }
    setBusy(null);
    alertError(t('entry.accounts.failed'), started.ok ? undefined : started.message || undefined);
  };

  const unlink = async (provider: IdentityGlue) => {
    const name = t(provider.title);
    const ok = await confirmAction({
      title: t('entry.accounts.unbindTitle', { name }),
      message: t('entry.accounts.unbindMessage'),
      confirmLabel: t('entry.accounts.unbind'),
      destructive: true,
    });
    if (!ok) return;
    const current = captureIdentity();
    setBusy(provider.id);
    const result = await removeBinding(provider.path);
    if (!current()) return;
    setBusy(null);
    if (!result.ok) return alertError(t('entry.accounts.failed'), result.message || undefined);
    toast(t('entry.accounts.unbound', { name }), 'check');
    void load();
  };

  const shown = providers.filter((provider) => standing[provider.id]?.available);
  if (!shown.length) return null;
  return (
    <Section header={t('entry.accounts.title')} footer={t('entry.accounts.footer')}>
      {shown.map((provider) => {
        const binding = standing[provider.id]?.binding ?? null;
        return (
          <Row
            key={provider.id}
            title={t(provider.title)}
            subtitle={
              binding
                ? t('entry.accounts.bound', { name: binding.provider_name || binding.provider_user_id })
                : t('entry.accounts.notBound')
            }
            icon="person"
            accessory={
              <NativeButton
                testID={`binding-${provider.id}`}
                size="small"
                label={binding ? t('entry.accounts.unbind') : t('entry.accounts.bind')}
                destructive={!!binding}
                loading={busy === provider.id}
                onPress={() => void (binding ? unlink(provider) : link(provider))}
              />
            }
          />
        );
      })}
    </Section>
  );
}
