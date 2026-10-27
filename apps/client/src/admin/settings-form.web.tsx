/**
 * Workspace settings (GET/PUT /api/admin/settings) as grouped rows: Runtime config shows every
 * group except branding and team context; a plugin's settings-form section shows its declared
 * keys. Only staged keys are sent; secrets are write-only; Clear falls back to the env var.
 * (src/plugins/settings-screen.tsx stays the phone / plugin-page form; this one is the dense
 * desktop layout with sources, clear and env fallbacks that Administration needs.)
 */
import React, { useCallback, useState } from 'react';
import { useResource } from '../data/use-resource';
import { useStationManifest } from '../plugins/store';
import { localize } from '../shared/plugins';
import { usePrefs } from '../store/prefs';
import { useT, type TranslationKey } from '../lib/i18n';
import { toast } from '../ui/toast';
import { alertError } from '../ui/dialogs';
import * as admin from './api';
import { Badge, Card, SectionState, Switch } from './kit.web';
import { useWrite } from './use-write';
import {
  RUNTIME_GROUPS,
  clearState,
  descriptionParts,
  fieldText,
  flagChecked,
  settingGroups,
  settingsPayload,
  shownSource,
  type Staged,
} from './settings-model';
import type { WorkspaceSettingView } from './types';

export function Description({ text }: { text: string }) {
  return (
    <>
      {descriptionParts(text).map((part, index) =>
        part.code ? <code key={index}>{part.text}</code> : <React.Fragment key={index}>{part.text}</React.Fragment>,
      )}
    </>
  );
}

export function SettingsForm({ keys, intro }: { keys?: string[]; intro?: string }) {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const manifest = useStationManifest((s) => s.data);
  const data = useResource(useCallback(() => admin.listSettings(), []));
  const [staged, setStaged] = useState<Staged>({});
  const { busy, run } = useWrite();
  const views = data.data?.settings;
  const stage = (key: string, value: string | boolean | null) => setStaged((s) => ({ ...s, [key]: value }));
  const unstage = (key: string) =>
    setStaged((s) => {
      const next = { ...s };
      delete next[key];
      return next;
    });
  const groupLabel = (group: string) => {
    if ((RUNTIME_GROUPS as readonly string[]).includes(group))
      return t(`admin.runtime.group.${group}` as TranslationKey);
    const plugin = manifest.kind === 'v2' ? manifest.manifest.plugins.find((p) => p.id === group) : undefined;
    return plugin ? localize(plugin.name, lang) : group;
  };
  const save = async () => {
    if (!views) return;
    const payload = settingsPayload(views, staged);
    if ('invalid' in payload) {
      alertError(t('admin.runtime.invalidJson', { name: payload.invalid }));
      return;
    }
    const answer = await run(() => admin.saveSettings(payload.values), t('admin.saveFailed'));
    if (!answer) return;
    data.setData(answer);
    setStaged({});
    toast(t('admin.saved'));
  };
  if (!views) return <SectionState loading={data.loading} error={data.error} retry={() => void data.refresh()} />;
  const groups = settingGroups(views, keys);
  const pending = Object.keys(staged).length;
  return (
    <div className="gh-admin-settings">
      {intro ? <p className="gh-hint">{intro}</p> : null}
      {groups.map(({ group, settings }) => (
        <Card key={group} title={keys ? undefined : groupLabel(group)} flush>
          {settings.map((view) => (
            <SettingRow
              key={view.key}
              view={view}
              staged={staged[view.key]}
              stage={(value) => stage(view.key, value)}
              unstage={() => unstage(view.key)}
            />
          ))}
        </Card>
      ))}
      {!groups.length ? <p className="gh-admin-empty-line">{t('admin.runtime.none')}</p> : null}
      <div className="gh-savebar">
        <button className="gh-primary" disabled={busy || !pending} onClick={() => void save()}>
          {t('common.save')}
        </button>
        {pending ? <small>{t('admin.runtime.pending', { n: pending })}</small> : null}
        {pending ? (
          <button className="gh-link-button" disabled={busy} onClick={() => setStaged({})}>
            {t('admin.runtime.discard')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function SettingRow({
  view,
  staged,
  stage,
  unstage,
}: {
  view: WorkspaceSettingView;
  staged: Staged[string] | undefined;
  stage: (value: string | boolean | null) => void;
  unstage: () => void;
}) {
  const t = useT();
  const source = shownSource(view, staged);
  const clear = clearState(view, staged);
  const checked = flagChecked(view, staged);
  const multiline = view.type === 'text' || view.type === 'json';
  const label = view.label || view.key;
  const placeholder = view.secret
    ? view.has_value && staged === undefined
      ? t('admin.runtime.secretSet')
      : t('admin.runtime.secretPlaceholder')
    : undefined;
  return (
    <div className="gh-setting-row" data-testid={`setting-${view.key}`}>
      <div className="gh-setting-label">
        <span>
          {label} <Badge tone={source === 'db' ? 'accent' : 'neutral'}>{t(`admin.runtime.source.${source}`)}</Badge>
        </span>
        {view.env ? <small className="gh-mono">{t('admin.runtime.envFallback', { env: view.env })}</small> : null}
      </div>
      <div className="gh-setting-control">
        {view.type === 'boolean' ? (
          <>
            <Switch checked={checked} label={label} onChange={(next) => stage(next)} />
            <span>{checked ? t('admin.on') : t('admin.off')}</span>
            <span style={{ flex: 1 }} />
          </>
        ) : multiline ? (
          <textarea
            className="gh-input gh-mono"
            aria-label={label}
            rows={view.type === 'json' ? 4 : 3}
            spellCheck={false}
            value={fieldText(view, staged)}
            placeholder={placeholder}
            onChange={(e) => stage(e.target.value)}
          />
        ) : (
          <input
            className="gh-input gh-mono"
            aria-label={label}
            type={view.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            value={fieldText(view, staged)}
            placeholder={placeholder}
            onChange={(e) => stage(e.target.value)}
          />
        )}
        {clear === 'clear' ? (
          <button type="button" className="gh-secondary-button" onClick={() => stage(null)}>
            {t('admin.runtime.clear')}
          </button>
        ) : clear === 'undo' ? (
          <button type="button" className="gh-secondary-button" onClick={unstage}>
            {t('admin.runtime.undo')}
          </button>
        ) : null}
      </div>
      {view.description ? (
        <p className="gh-hint">
          <Description text={view.description} />
        </p>
      ) : null}
    </div>
  );
}
