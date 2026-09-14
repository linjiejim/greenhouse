/**
 * Runtime Config (super only) — registry-driven workspace settings editor for
 * the runtime credentials: main LLM, media (vision + image generation), web search.
 *
 * Rendered straight from the settings registry (@greenhouse/types, plus the
 * entries active extensions register): adding a setting makes it appear here —
 * no page changes. Extension settings render as one section per extension.
 * Values saved here win
 * over env vars and apply immediately (the API re-overlays process.env after
 * every write); clearing a field falls back to the env var. Secrets are
 * write-only: the server exposes has_value/source, never the value.
 *
 * Branding keys are deliberately excluded — they live in the Branding Studio.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { WorkspaceSettingGroup, WorkspaceSettingView } from '@greenhouse/types';
import { Button, Input, Spinner, toast } from '../../components/ui';
import { ModulePage } from '../../components/app/module-page';
import { useI18n } from '../../lib/i18n';
import type { TranslationKey } from '../../lib/i18n';
import { fetchWorkspaceSettings, saveWorkspaceSettings } from '../../lib/api/workspace-settings';
import { useExtensionsStore } from '../../stores/extensions-store';

const RUNTIME_GROUPS: WorkspaceSettingGroup[] = ['llm', 'media', 'search'];

function SourceBadge({ source }: { source: WorkspaceSettingView['source'] }) {
  const { t } = useI18n();
  const styles: Record<WorkspaceSettingView['source'], string> = {
    db: 'bg-primary-subtle text-primary-fg-strong',
    env: 'bg-surface-muted text-fg-secondary',
    none: 'bg-surface-muted text-fg-faint',
  };
  const labels: Record<WorkspaceSettingView['source'], string> = {
    db: t('runtimeConfig.sourceDb'),
    env: t('runtimeConfig.sourceEnv'),
    none: t('runtimeConfig.sourceNone'),
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium whitespace-nowrap ${styles[source]}`}>
      {labels[source]}
    </span>
  );
}

export function RuntimeConfigPanel() {
  const { t } = useI18n();
  const [views, setViews] = useState<WorkspaceSettingView[] | null>(null);
  const [dirty, setDirty] = useState<Record<string, string | null>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchWorkspaceSettings()
      .then(setViews)
      .catch((err) => setError(err?.message || 'Failed to load'));
  }, []);

  const extensions = useExtensionsStore((s) => s.extensions);

  // Core runtime groups first, then one section per extension group (any group
  // that is neither core nor branding), in registration order.
  const grouped = useMemo(() => {
    const map = new Map<string, WorkspaceSettingView[]>();
    for (const g of RUNTIME_GROUPS) map.set(g, []);
    for (const v of views ?? []) {
      if (v.group === 'branding') continue;
      if (!map.has(v.group)) map.set(v.group, []);
      map.get(v.group)!.push(v);
    }
    return map;
  }, [views]);

  const groupLabel = (group: string): string => {
    if ((RUNTIME_GROUPS as string[]).includes(group)) return t(`runtimeConfig.group_${group}` as TranslationKey);
    const name = extensions.find((e) => e.id === group)?.name ?? group;
    return t('runtimeConfig.group_extension', { name });
  };

  const stage = (key: string, value: string | null) => {
    setDirty((prev) => ({ ...prev, [key]: value }));
  };
  const unstage = (key: string) => {
    setDirty((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleSave = async () => {
    if (!Object.keys(dirty).length) return;
    setSaving(true);
    try {
      const next = await saveWorkspaceSettings(dirty);
      setViews(next);
      setDirty({});
      toast(t('runtimeConfig.saved'), 'success');
    } catch (err: any) {
      toast(err?.message || 'Save failed', 'error');
    }
    setSaving(false);
  };

  if (error) {
    return (
      <ModulePage moduleId="admin.runtime-config" layout="form">
        <div className="text-sm text-danger bg-danger-subtle px-3 py-2 rounded-lg">{error}</div>
      </ModulePage>
    );
  }
  if (!views) {
    return (
      <ModulePage moduleId="admin.runtime-config" layout="form">
        <div className="flex items-center justify-center py-16">
          <Spinner />
        </div>
      </ModulePage>
    );
  }

  return (
    <ModulePage moduleId="admin.runtime-config" layout="form">
      <div className="space-y-6 max-w-3xl">
        <p className="text-xs text-fg-muted leading-relaxed">{t('runtimeConfig.intro')}</p>

        {[...grouped.keys()].map((group) => (
          <section key={group} className="bg-surface-raised border border-edge rounded-xl p-4">
            <h3 className="text-sm font-semibold text-fg mb-3">{groupLabel(group)}</h3>
            <div className="space-y-3">
              {(grouped.get(group) ?? []).map((v) => {
                const staged = dirty[v.key];
                const isCleared = staged === null;
                const inputValue = isCleared ? '' : (staged ?? (v.secret ? '' : String(v.value ?? '')));
                const secretPlaceholder =
                  v.secret && v.has_value && staged === undefined
                    ? `${t('runtimeConfig.secretSet')} ••••••`
                    : t('runtimeConfig.secretPlaceholder');
                return (
                  <div key={v.key} className="grid md:grid-cols-[220px_minmax(0,1fr)] gap-x-4 gap-y-1 items-start">
                    <div className="pt-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-fg-secondary">{v.label}</span>
                        <SourceBadge
                          source={isCleared ? (v.env ? 'env' : 'none') : staged !== undefined ? 'db' : v.source}
                        />
                      </div>
                      {v.env && (
                        <p className="text-[9px] text-fg-faint font-mono mt-0.5">
                          {t('runtimeConfig.envFallback')} {v.env}
                        </p>
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <Input
                          type={v.secret ? 'password' : 'text'}
                          value={inputValue}
                          onChange={(e) => stage(v.key, e.target.value)}
                          placeholder={v.secret ? secretPlaceholder : v.value == null ? '' : undefined}
                          size="sm"
                          className="flex-1 font-mono text-xs"
                          spellCheck={false}
                          autoComplete="off"
                        />
                        {(v.has_value || staged !== undefined) && !isCleared ? (
                          <Button variant="outline" size="sm" onClick={() => stage(v.key, null)}>
                            {t('runtimeConfig.clear')}
                          </Button>
                        ) : isCleared ? (
                          <Button variant="outline" size="sm" onClick={() => unstage(v.key)}>
                            ↺
                          </Button>
                        ) : null}
                      </div>
                      <p className="text-[10px] text-fg-faint mt-0.5">{v.description}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={saving || !Object.keys(dirty).length}>
            {saving ? t('common.saving') : t('runtimeConfig.save')}
          </Button>
          {Object.keys(dirty).length > 0 && (
            <span className="text-[10px] text-fg-faint">
              {t('runtimeConfig.pendingCount', { count: Object.keys(dirty).length })}
            </span>
          )}
        </div>
      </div>
    </ModulePage>
  );
}
