import { errorText } from '../../lib/errors';
import { useOverlayDraft } from '../../lib/useOverlayDraft';
/**
 * Provider instances, shared by 管理 → 服务 and 设置 → 我的服务 (providers.md): a row with the
 * last check, and a drawer to add or edit one from the adapter catalog. Keys are write-only:
 * once saved they only show as set.
 */

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import {
  Badge,
  Button,
  Field,
  FieldGroup,
  Input,
  Menu,
  Overlay,
  OverlayActions,
  SecretField,
  Select,
  StatusBadge,
  Switch,
  type MenuEntry,
  type Tone,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { CatalogAdapter, ProviderCapability, ProviderInstance } from '@greenhouse/contract';
import type { MessageKey } from '../../i18n/zh';
import { useI18n } from '../../lib/i18n';
import { SchemaFields, type JsonSchema } from './SchemaForm';

export const CAPABILITY_LABEL: Record<ProviderCapability, MessageKey> = {
  llm: 'provider.llm',
  stt: 'provider.stt',
  tts: 'provider.tts',
  image: 'provider.image',
  video: 'provider.video',
  sandbox: 'provider.sandbox',
  search: 'provider.search',
  storage: 'provider.storage',
  mail: 'provider.mail',
  im: 'provider.im',
  push: 'provider.push',
};

export function checkOf(instance: ProviderInstance): { word: MessageKey; tone: Tone } {
  if (!instance.enabled) return { word: 'provider.off', tone: 'neutral' };
  if (!instance.last_check) return { word: 'provider.untested', tone: 'neutral' };
  return instance.last_check.ok
    ? { word: 'provider.ok', tone: 'success' }
    : { word: 'provider.failing', tone: 'danger' };
}

export interface InstanceApi {
  create: (input: {
    capability: ProviderCapability;
    kind: string;
    preset?: string;
    name: string;
    config: Record<string, unknown>;
    secrets: Record<string, string>;
  }) => Promise<unknown>;
  update: (
    id: string,
    input: { name?: string; config?: Record<string, unknown>; secrets?: Record<string, string>; enabled?: boolean },
  ) => Promise<unknown>;
}

export function InstanceRow({
  instance,
  index,
  actions,
  extra,
}: {
  instance: ProviderInstance;
  index?: number;
  actions: MenuEntry[];
  /** Trailing controls (the order buttons). */
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  const check = checkOf(instance);
  return (
    <li className="app-list-row is-static">
      {index !== undefined && <span className="app-order">{index + 1}</span>}
      <span className="app-list-main">
        <span className="app-list-title">{instance.name}</span>
        {instance.last_check?.error && <span className="app-list-meta">{instance.last_check.error}</span>}
        {instance.last_check?.ok && instance.last_check.latency_ms !== undefined && (
          <span className="app-list-meta">{instance.last_check.latency_ms} ms</span>
        )}
      </span>
      {instance.source === 'env' && (
        <Badge>
          <Lock size={icon.sm} /> {t('provider.fromEnv')}
        </Badge>
      )}
      <StatusBadge status={t(check.word)} tone={check.tone} />
      {extra}
      {actions.length > 0 && <Menu label={t('provider.actionsFor', { name: instance.name })} items={actions} />}
    </li>
  );
}

export function InstanceDrawer({
  capability,
  catalog,
  instance,
  api,
  onClose,
}: {
  capability: ProviderCapability;
  catalog: CatalogAdapter[];
  /** Editing this one; otherwise a new one. */
  instance?: ProviderInstance;
  api: InstanceApi;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const adapters = useMemo(() => catalog.filter((adapter) => adapter.capability === capability), [catalog, capability]);
  const [kind, setKind] = useState(instance?.kind ?? adapters[0]?.kind ?? '');
  const adapter = adapters.find((item) => item.kind === kind);
  const [preset, setPreset] = useState(instance?.preset ?? adapter?.presets[0]?.id ?? '');
  const [name, setName] = useState(instance?.name ?? '');
  const [config, setConfig] = useState<Record<string, unknown>>(instance?.config ?? adapter?.presets[0]?.config ?? {});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(instance?.enabled ?? true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const pickAdapter = (next: string) => {
    const chosen = adapters.find((item) => item.kind === next);
    setKind(next);
    setPreset(chosen?.presets[0]?.id ?? '');
    setConfig(chosen?.presets[0]?.config ?? {});
  };
  const pickPreset = (next: string) => {
    setPreset(next);
    const chosen = adapter?.presets.find((item) => item.id === next);
    if (chosen) setConfig({ ...chosen.config });
  };

  const dismiss = useOverlayDraft({ kind, preset, name, config, secrets, enabled }, saving, onClose);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError(t('request.required', { name: t('provider.name') }));
    if (!instance) {
      const missing = adapter?.required_secrets.find((key) => !secrets[key]?.trim());
      if (missing) return setError(t('request.required', { name: missing }));
    }
    setSaving(true);
    try {
      if (instance) await api.update(instance.id, { name: name.trim(), config, enabled });
      else
        await api.create({
          capability,
          kind,
          ...(preset ? { preset } : {}),
          name: name.trim(),
          config,
          secrets,
        });
      onClose();
    } catch (caught) {
      setError(errorText(caught, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Overlay
        title={instance ? instance.name : t('provider.add', { name: t(CAPABILITY_LABEL[capability]) })}
        onClose={onClose}
        beforeClose={dismiss.beforeClose}
      >
        <form
          {...dismiss.formProps}
          id="provider-instance"
          className="app-form"
          onSubmit={(event) => void submit(event)}
        >
          {!instance && adapters.length > 1 && (
            <FieldGroup label={t('provider.adapter')}>
              <Select
                label={t('provider.adapter')}
                value={kind}
                options={adapters.map((item) => ({ value: item.kind, label: item.label }))}
                onChange={pickAdapter}
              />
            </FieldGroup>
          )}
          {!instance && (adapter?.presets.length ?? 0) > 1 && (
            <FieldGroup label={t('provider.preset')}>
              <Select
                label={t('provider.preset')}
                value={preset}
                options={adapter!.presets.map((item) => ({ value: item.id, label: item.label }))}
                onChange={pickPreset}
              />
            </FieldGroup>
          )}
          <Field label={t('provider.name')} required>
            <Input
              value={name}
              maxLength={60}
              autoFocus
              onChange={(event) => {
                setName(event.target.value);
                setError('');
              }}
            />
          </Field>
          {adapter && <SchemaFields schema={adapter.config_schema as JsonSchema} value={config} onChange={setConfig} />}
          {(adapter?.secret_keys ?? []).map((key) =>
            instance ? (
              <SecretField
                key={key}
                label={key}
                configured={instance.secrets_set.includes(key)}
                onSave={(value) => void api.update(instance.id, { secrets: { [key]: value } }).catch(() => undefined)}
              />
            ) : (
              <Field key={key} label={key} required={adapter?.required_secrets.includes(key)}>
                <Input
                  type="password"
                  autoComplete="off"
                  value={secrets[key] ?? ''}
                  onChange={(event) => setSecrets({ ...secrets, [key]: event.target.value })}
                />
              </Field>
            ),
          )}
          {instance && (
            <div className="app-setting-row is-plain">
              <span className="app-setting-text">
                <strong>{t('provider.enabled')}</strong>
              </span>
              <Switch label={t('provider.enabled')} checked={enabled} onChange={setEnabled} />
            </div>
          )}
          <p className="app-muted">{t('provider.keysGoOnly')}</p>
          {error && (
            <p className="app-form-error" role="alert">
              {error}
            </p>
          )}
        </form>
        <OverlayActions>
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form="provider-instance" loading={saving}>
            {instance ? t('common.save') : t('provider.addButton')}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}
