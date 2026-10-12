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
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object');
      const config = value as Record<string, unknown>;
      if (
        !Array.isArray(config.bindings) ||
        (config.actions !== undefined && !Array.isArray(config.actions)) ||
        Object.keys(config).some((key) => !['bindings', 'actions', 'create'].includes(key))
      )
        throw new Error('shape');
      // The draft endpoint validates every field, reference and role before storing it.
      const { create: _create, actions: _actions, ...base } = card;
      onChange({ ...base, ...config } as CustomCard);
      setError('');
    } catch {
      setError(t('apps.sandbox.invalidSettings'));
    }
  };
  return (
    <>
      {!enabled && (
        <p role="alert" className="text-xs text-warning">
          {t('apps.sandbox.disabled')}
        </p>
      )}
      <PanelSection title={t('apps.sandbox.code')} hint={t('apps.sandbox.codeHint')}>
        <Textarea
          rows={18}
          spellCheck={false}
          className="font-mono text-xs"
          value={card.html}
          disabled={!enabled}
          aria-label={t('apps.sandbox.code')}
          data-testid="app-custom-code"
          onChange={(event) => onChange({ ...card, html: event.target.value })}
        />
        <p className="text-xs text-fg-muted">
          {new TextEncoder().encode(card.html).byteLength} / {APP_SANDBOX_LIMITS.htmlBytes}
        </p>
      </PanelSection>
      <PanelSection title={t('apps.sandbox.bindings')} hint={t('apps.sandbox.bindingsHint')}>
        <Textarea
          rows={18}
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
      <PanelSection title={t('apps.sandbox.bridge')} hint={t('apps.sandbox.bridgeHint')}>
        <pre className="overflow-auto whitespace-pre-wrap text-xs">
          {
            'await greenhouse.query("rows", { cursor });\nawait greenhouse.action("approve", { recordId, values: [] });\nawait greenhouse.create([{ fieldId: 1, value: "…" }]);'
          }
        </pre>
      </PanelSection>
    </>
  );
}
