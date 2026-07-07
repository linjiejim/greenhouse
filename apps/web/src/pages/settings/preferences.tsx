/**
 * Preferences panel — personal notes, theme, language, linked SSO accounts.
 * Embedded as a sub-module of the Settings page.
 * Title/description shown in TopBar breadcrumb — not repeated here.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, Textarea, ConfirmDialog, toast } from '../../components/ui';
import { authFetch, fetchSsoProviders } from '../../lib/auth';
import type { SsoProviderInfo } from '../../lib/auth';
import { Sparkles, Palette, Globe, Link } from '../../lib/icons';
import { ThemeModeSelector } from '../../components/app/theme-mode-selector';
import { useI18n, LOCALE_OPTIONS } from '../../lib/i18n';
import { useAuthStore } from '../../stores';

const MAX_NOTES_LENGTH = 500;

// ─── Linked accounts (SSO identity binding) ──────────────

interface BoundIdentity {
  provider: string;
  subject: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  last_login_at: string | null;
}

/** Bind-flow results landed via ?sso_bind= → i18n keys (ok handled separately). */
const BIND_ERROR_KEYS: Record<string, string> = {
  already_bound: 'preferences.ssoBindAlreadyBound',
  provider_already_linked: 'preferences.ssoBindProviderLinked',
  provider_error: 'preferences.ssoBindProviderError',
  invalid_state: 'preferences.ssoBindInvalidState',
};

function LinkedAccountsSection() {
  const { t } = useI18n();
  const [providers, setProviders] = useState<SsoProviderInfo[]>([]);
  const [identities, setIdentities] = useState<BoundIdentity[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unbindTarget, setUnbindTarget] = useState<SsoProviderInfo | null>(null);

  const reload = useCallback(async () => {
    const [provs, res] = await Promise.all([fetchSsoProviders(), authFetch('/api/auth/sso/identities')]);
    setProviders(provs);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      setIdentities(Array.isArray(data.identities) ? data.identities : []);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Bind-flow landing: the SSO callback redirects here with ?sso_bind=ok|<code>.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const bindResult = params.get('sso_bind');
    if (!bindResult) return;
    params.delete('sso_bind');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    );
    if (bindResult === 'ok') {
      toast(t('preferences.ssoBindSuccess'), 'success');
    } else {
      const key = BIND_ERROR_KEYS[bindResult];
      toast(key ? t(key) : t('preferences.ssoBindFailed'), 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot URL param handling
  }, []);

  const handleBind = async (provider: SsoProviderInfo) => {
    try {
      const res = await authFetch(`/api/auth/sso/${provider.id}/bind-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect: '/#/settings/preferences' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        toast(data.error || t('preferences.ssoBindFailed'), 'error');
        return;
      }
      window.location.href = data.url;
    } catch {
      toast(t('preferences.ssoBindFailed'), 'error');
    }
  };

  const handleUnbind = async () => {
    if (!unbindTarget) return;
    const target = unbindTarget;
    setUnbindTarget(null);
    try {
      const res = await authFetch(`/api/auth/sso/identities/${target.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error || t('preferences.ssoUnbindFailed'), 'error');
        return;
      }
      toast(t('preferences.ssoUnbindSuccess'), 'success');
      reload();
    } catch {
      toast(t('preferences.ssoUnbindFailed'), 'error');
    }
  };

  // No connectors configured on the server — the whole section disappears.
  if (!loaded || providers.length === 0) return null;

  return (
    <section>
      <label className="flex items-center gap-2 text-sm font-medium text-fg-secondary mb-1.5">
        <Link size={14} className="text-primary-fg" />
        {t('preferences.linkedAccounts')}
      </label>
      <p className="text-xs text-fg-muted mb-2.5">{t('preferences.linkedAccountsHint')}</p>
      <div className="border border-edge rounded-lg divide-y divide-edge">
        {providers.map((p) => {
          const bound = identities.find((i) => i.provider === p.id);
          return (
            <div key={p.id} className="flex items-center justify-between px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm text-fg">{p.label}</div>
                {bound ? (
                  <div className="text-xs text-fg-muted truncate">
                    {t('preferences.ssoBoundAs', { name: bound.display_name || bound.subject })}
                  </div>
                ) : (
                  <div className="text-xs text-fg-faint">{t('preferences.ssoNotBound')}</div>
                )}
              </div>
              {bound ? (
                <Button size="sm" variant="secondary" onClick={() => setUnbindTarget(p)}>
                  {t('preferences.ssoUnbind')}
                </Button>
              ) : (
                <Button size="sm" onClick={() => handleBind(p)}>
                  {t('preferences.ssoBind')}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={unbindTarget !== null}
        onClose={() => setUnbindTarget(null)}
        onConfirm={handleUnbind}
        title={t('preferences.ssoUnbindTitle')}
        description={t('preferences.ssoUnbindDesc', { provider: unbindTarget?.label ?? '' })}
        confirmLabel={t('preferences.ssoUnbind')}
        confirmVariant="destructive"
      />
    </section>
  );
}

export function PreferencesPanel() {
  const { t, locale, setLocale } = useI18n();
  const { currentUser, updateUser } = useAuthStore();
  const [notes, setNotes] = useState(currentUser?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNotes(currentUser?.notes ?? '');
    setSaved(false);
    setError(null);
  }, [currentUser?.notes]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await authFetch('/api/auth/me/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: notes.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `${t('common.saveFailed')} (${res.status})`);
      }
      const data = await res.json();
      updateUser({ notes: data.notes });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remaining = MAX_NOTES_LENGTH - notes.length;

  return (
    <div className="space-y-6">
      {/* AI Personal Notes — top priority */}
      <section>
        <div className="flex items-start gap-2.5 p-2.5 bg-primary-subtle border border-primary-edge rounded-lg mb-3">
          <Sparkles size={15} className="text-primary-fg mt-0.5 flex-shrink-0" />
          <p className="text-xs text-primary-fg-strong leading-relaxed">{t('preferences.notesHint')}</p>
        </div>

        <label className="block text-sm font-medium text-fg-secondary mb-1.5">{t('preferences.personalNotes')}</label>
        <Textarea
          value={notes}
          onChange={(e) => {
            if (e.target.value.length <= MAX_NOTES_LENGTH) {
              setNotes(e.target.value);
            }
          }}
          placeholder={t('preferences.notesPlaceholder')}
          rows={5}
          className="resize-none"
        />
        <div className="flex items-center justify-between mt-1.5">
          <span className={`text-[10px] ${remaining < 50 ? 'text-warning' : 'text-fg-faint'}`}>
            {t('preferences.charactersRemaining', { count: remaining })}
          </span>
          <div className="flex items-center gap-2">
            {saved && <span className="text-xs text-primary-fg font-medium">{t('common.saved')}</span>}
            <Button size="sm" onClick={handleSave} disabled={saving || notes === (currentUser?.notes ?? '')}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
        {error && (
          <p className="text-xs text-danger bg-danger-subtle border border-danger rounded-lg px-3 py-2 mt-2">{error}</p>
        )}
      </section>

      {/* Theme + Language — each on its own full-width row */}
      <div className="space-y-6">
        {/* Theme Mode — light / dark / system */}
        <section>
          <label className="flex items-center gap-2 text-sm font-medium text-fg-secondary mb-2.5">
            <Palette size={14} className="text-primary-fg" />
            {t('preferences.theme')}
          </label>
          <ThemeModeSelector />
        </section>

        {/* Language Selector */}
        <section>
          <label className="flex items-center gap-2 text-sm font-medium text-fg-secondary mb-2.5">
            <Globe size={14} className="text-primary-fg" />
            {t('preferences.language')}
          </label>
          <div className="flex gap-2">
            {LOCALE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setLocale(opt.value)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border-2 transition-all ${
                  locale === opt.value
                    ? 'border-primary-500 bg-primary-subtle/50 text-primary-fg-strong font-medium shadow-sm'
                    : 'border-edge text-fg-secondary hover:border-edge-strong hover:bg-surface-sunken'
                }`}
              >
                <span className="text-sm">{opt.nativeLabel}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Linked SSO accounts — hidden for the shared guest account and when
            the server has no connectors configured */}
        {currentUser && currentUser.role !== 'external' && <LinkedAccountsSection />}
      </div>
    </div>
  );
}
