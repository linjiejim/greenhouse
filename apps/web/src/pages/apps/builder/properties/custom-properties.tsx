/** Advanced HTML component editor. The saved binding/action JSON uses the same server validator as every card. */
import { useState } from 'react';
import type { AppCard } from '@greenhouse/types/apps';
import { APP_SANDBOX_LIMITS } from '@greenhouse/types/app-sandbox';
import { Button, Textarea } from '../../../../components/ui';
import { useT } from '../../../../lib/i18n';
import { canUseFeature } from '../../../../lib/features';
import { useAuthStore } from '../../../../stores';
import type { BuilderSchema } from '../spec-model';
import { PanelSection } from './common';

type CustomCard = Extract<AppCard, { kind: 'custom' }>;
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function settings(card: CustomCard) {
  return JSON.stringify(
    { bindings: card.bindings, actions: card.actions ?? [], ...(card.create ? { create: card.create } : {}) },
    null,
    2,
  );
}
export function CustomProperties({
  card,
  schema,
  onChange,
}: {
  card: CustomCard;
  schema: BuilderSchema;
  onChange(card: CustomCard): void;
}) {
  const t = useT();
  const user = useAuthStore((state) => state.currentUser);
  const enabled = canUseFeature(user, 'apps_custom_code');
  const [json, setJson] = useState(() => settings(card));
  const [error, setError] = useState('');
  const apply = () => {
    try {
      const value: unknown = JSON.parse(json);
      if (!isObject(value)) throw new Error('object');
      const config = value;
      if (
        !Array.isArray(config.bindings) ||
        config.bindings.some((binding) => !isObject(binding) || !isObject(binding.source)) ||
        (config.actions !== undefined &&
          (!Array.isArray(config.actions) ||
            config.actions.some((action) => !isObject(action) || !isObject(action.do)))) ||
        (config.create !== undefined && !isObject(config.create)) ||
        Object.keys(config).some((key) => !['bindings', 'actions', 'create'].includes(key))
      )
        throw new Error('shape');
      // Keep malformed objects out of local state. The draft endpoint validates
      // every field, reference and role before storing the complete spec.
      const { create: _create, actions: _actions, ...base } = card;
      onChange({ ...base, ...config } as CustomCard);
      setError('');
    } catch {
      setError(t('apps.sandbox.invalidSettings'));
    }
  };
  return (
    <>
      <p
        className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-xs leading-5 text-warning"
        data-testid="app-custom-execution-notice"
      >
        {t('apps.sandbox.editorNotice')}
      </p>
      {!enabled && (
        <p role="alert" className="text-xs text-warning">
          {t('apps.sandbox.disabled')}
        </p>
      )}
      <PanelSection title={t('apps.sandbox.code')} hint={t('apps.sandbox.codeHint')}>
        <Textarea
          rows={10}
          spellCheck={false}
          className="font-mono text-xs"
          value={card.html}
          disabled={!enabled}
          aria-label={t('apps.sandbox.code')}
          data-testid="app-custom-code"
          onChange={(event) => onChange({ ...card, html: event.target.value })}
        />
        <p className="text-xs text-fg-muted">
          {t('apps.sandbox.codeSize', {
            used: Math.ceil(new TextEncoder().encode(card.html).byteLength / 1024),
            limit: APP_SANDBOX_LIMITS.htmlBytes / 1024,
          })}
        </p>
      </PanelSection>
      <PanelSection title={t('apps.sandbox.bindings')} hint={t('apps.sandbox.bindingsHint')} defaultOpen={false}>
        <Textarea
          rows={10}
          spellCheck={false}
          className="font-mono text-xs"
          value={json}
          disabled={!enabled}
          aria-label={t('apps.sandbox.bindings')}
          data-testid="app-custom-settings"
          onChange={(event) => setJson(event.target.value)}
        />
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <Button size="sm" variant="outline" onClick={apply} disabled={!enabled} data-testid="app-custom-settings-apply">
          {t('common.apply')}
        </Button>
        <details className="text-xs">
          <summary>{t('apps.sandbox.schema')}</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(
              schema.tables.map((table) => ({
                tableId: table.id,
                name: table.name,
                fields: (schema.fieldsByTable.get(table.id) ?? []).map((field) => ({
                  fieldId: field.id,
                  name: field.name,
                  type: field.type,
                })),
              })),
              null,
              2,
            )}
          </pre>
        </details>
      </PanelSection>
      <PanelSection title={t('apps.sandbox.bridge')} hint={t('apps.sandbox.bridgeHint')} defaultOpen={false}>
        <pre className="overflow-auto whitespace-pre-wrap text-xs">
          {
            'await greenhouse.query("rows", { cursor });\nawait greenhouse.action("approve", { recordId, values: [] });\nawait greenhouse.create([{ fieldId: 1, value: "…" }]);'
          }
        </pre>
      </PanelSection>
    </>
  );
}
