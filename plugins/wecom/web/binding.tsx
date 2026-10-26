/**
 * WeCom binding card — Settings › Greenhouse Admin (provider bindings).
 *
 * Binding a WeCom identity is what makes "notify me personally" possible at
 * all: every direct-message channel derives its recipient from this row, never
 * from a configurable field (spec D3).
 *
 * The card renders nothing when the deployment has no WeCom app configured. A
 * button that always 503s is a capability claim the product cannot honour.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle, LogIn, LogOut } from '@greenhouse/web/extension-kit';
import { Button, Spinner, Tag, toast } from '@greenhouse/web/extension-kit';
import { fetchWeComBinding, startWeComBinding, unbindWeCom, type WeComBindingState } from './api';
import { formatDate } from '@greenhouse/web/extension-kit';
import { useT } from '@greenhouse/web/extension-kit';

export function WeComBindingCard() {
  const t = useT();
  const [state, setState] = useState<WeComBindingState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setState(await fetchWeComBinding()), []);

  useEffect(() => {
    void load();
  }, [load]);

  // The callback leaves its result in the hash query on the way back; read it
  // once and clear it so a refresh does not repeat the toast.
  useEffect(() => {
    const query = window.location.hash.split('?')[1];
    if (!query) return;
    const params = new URLSearchParams(query);
    const outcome = params.get('wecom');
    if (!outcome) return;
    if (outcome === 'ok') toast(t('ext.wecom.wecom.bound'), 'success');
    else toast(t('ext.wecom.wecom.bindFailed', { reason: params.get('reason') ?? 'unknown' }), 'error');
    window.location.hash = window.location.hash.split('?')[0];
    void load();
  }, [load, t]);

  const bind = async () => {
    setBusy(true);
    try {
      // The server returns the consent URL rather than redirecting: this call
      // has to carry the Bearer token (it identifies who is binding), and a
      // full-page navigation cannot send headers.
      window.location.href = await startWeComBinding();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('ext.wecom.wecom.bindFailed', { reason: 'start' }), 'error');
      setBusy(false);
    }
  };

  const unbind = async () => {
    setBusy(true);
    try {
      await unbindWeCom();
      toast(t('ext.wecom.wecom.unbound'), 'success');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('ext.wecom.wecom.unbindFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;
  if (!state.available) return null;

  return (
    <div className="rounded-lg border border-edge bg-surface-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg">{t('ext.wecom.wecom.title')}</span>
            {state.binding && (
              <Tag tone="success">
                <CheckCircle size={11} className="mr-0.5" />
                {t('ext.wecom.wecom.connected')}
              </Tag>
            )}
          </div>
          <p className="mt-0.5 text-xs text-fg-muted">
            {state.binding
              ? t('ext.wecom.wecom.boundAs', {
                  name: state.binding.provider_name || state.binding.provider_user_id,
                  at: formatDate(state.binding.bound_at),
                })
              : t('ext.wecom.wecom.hint')}
          </p>
        </div>
        {state.binding ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={unbind}>
            {busy ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : <LogOut size={14} />}
            {t('ext.wecom.wecom.unbind')}
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={bind}>
            {busy ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : <LogIn size={14} />}
            {t('ext.wecom.wecom.bind')}
          </Button>
        )}
      </div>
    </div>
  );
}
