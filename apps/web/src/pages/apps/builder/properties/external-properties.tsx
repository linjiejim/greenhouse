import { FormField } from '../../../../components/form';
import { useState } from 'react';
import { isJsonPointer, type AppCard, type AppExternalSource, type AppSourceMap } from '@greenhouse/types/apps';
import { Input, Select, Textarea } from '../../../../components/ui';
import { useT } from '../../../../lib/i18n';

type ExternalCard = Extract<AppCard, { kind: 'external' }>;
function JsonInput({
  label,
  value,
  onChange,
  array = false,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  array?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  return (
    <FormField label={label} error={invalid ? t('apps.builder.external.invalidJson') : undefined}>
      <Textarea
        aria-label={label}
        rows={5}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            const parsed: unknown = JSON.parse(next);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) !== array) throw new Error();
            onChange(parsed);
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
    </FormField>
  );
}
export function ExternalProperties({ card, onChange }: { card: ExternalCard; onChange: (card: AppCard) => void }) {
  const t = useT();
  const source = card.source;
  const set = (next: AppExternalSource) => onChange({ ...card, source: next });
  const map = source.map;
  const pointer = (key: 'value' | 'rows' | 'group' | 'series') => (
    <FormField
      key={key}
      label={t(`apps.builder.external.${key}`)}
      error={
        key in map && !isJsonPointer(String(map[key as keyof typeof map] ?? ''))
          ? t('apps.builder.external.pointer')
          : undefined
      }
    >
      <Input
        value={key in map ? String(map[key as keyof typeof map] ?? '') : ''}
        onChange={(event) => set({ ...source, map: { ...map, [key]: event.target.value } as AppSourceMap })}
      />
    </FormField>
  );
  return (
    <div className="space-y-3" data-testid="app-external-properties">
      <p className="text-xs text-fg-muted">{t('apps.builder.external.hint')}</p>
      <FormField label={t('apps.builder.external.source')}>
        <Select
          value={source.kind}
          onChange={(event) =>
            set(
              event.target.value === 'tool'
                ? { kind: 'tool', toolId: '', input: {}, map }
                : { kind: 'connector', server: '', tool: '', input: {}, map },
            )
          }
        >
          <option value="tool">{t('apps.builder.external.readTool')}</option>
          <option value="connector">{t('apps.builder.external.connector')}</option>
        </Select>
      </FormField>
      {source.kind === 'tool' ? (
        <FormField label={t('apps.builder.external.tool')}>
          <Input value={source.toolId} onChange={(event) => set({ ...source, toolId: event.target.value })} />
        </FormField>
      ) : (
        <>
          <FormField label={t('apps.builder.external.server')}>
            <Input value={source.server} onChange={(event) => set({ ...source, server: event.target.value })} />
          </FormField>
          <FormField label={t('apps.builder.external.tool')}>
            <Input value={source.tool} onChange={(event) => set({ ...source, tool: event.target.value })} />
          </FormField>
        </>
      )}
      <JsonInput
        key={`${card.id}:${source.kind}`}
        label={t('apps.builder.external.input')}
        value={source.input}
        onChange={(input) => set({ ...source, input: input as Record<string, unknown> })}
      />
      <FormField label={t('apps.builder.external.display')}>
        <Select
          value={map.kind}
          onChange={(event) =>
            set({
              ...source,
              map:
                event.target.value === 'kpi'
                  ? { kind: 'kpi', value: '' }
                  : event.target.value === 'chart'
                    ? { kind: 'chart', rows: '', group: '/name', value: '/value' }
                    : { kind: 'table', rows: '', columns: [{ key: 'name', label: 'Name', path: '/name' }] },
            })
          }
        >
          <option value="kpi">{t('apps.builder.catalog.kinds.kpi.name')}</option>
          <option value="chart">{t('apps.builder.catalog.kinds.chart.name')}</option>
          <option value="table">{t('apps.builder.external.table')}</option>
        </Select>
      </FormField>
      {map.kind === 'kpi' ? (
        pointer('value')
      ) : (
        <>
          {pointer('rows')}
          {map.kind === 'chart' ? (
            <>
              {pointer('group')}
              {pointer('value')}
              {pointer('series')}
            </>
          ) : (
            <JsonInput
              key={card.id}
              array
              label={t('apps.builder.external.columns')}
              value={map.columns}
              onChange={(columns) => set({ ...source, map: { ...map, columns: columns as typeof map.columns } })}
            />
          )}
        </>
      )}
    </div>
  );
}
