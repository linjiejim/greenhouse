import { useId, useState } from 'react';
import {
  Button,
  Field,
  FieldGroup,
  Input,
  MultiSelect,
  Overlay,
  OverlayActions,
  Select,
  TextArea,
} from '@greenhouse/ui/kit';
import {
  isComputedType,
  type AppAction,
  type AppCard,
  type Base,
  type BaseTable,
  type Card,
} from '@greenhouse/contract';
import { usePeople } from '../../data/people';
import { useT } from '../../lib/i18n';
import { FieldInput, fromText } from '../tables/cells';
import { CardEditor as ChartEditor } from '../tables/dashboards/CardEditor';
import { CardFilter } from '../tables/dashboards/CardFilter';
import { localId } from './model';
const CHARTS: readonly AppCard['kind'][] = ['number', 'bar', 'line', 'pie', 'list'];
export const CARD_CHOICES: readonly AppCard['kind'][] = [
  'records',
  'table',
  'kanban',
  'form',
  'button',
  ...CHARTS,
  'custom',
] as const;
export function newCard(kind: AppCard['kind'], base: Base, title: string): AppCard {
  const table = base.tables[0]!;
  const id = localId();
  if (CHARTS.includes(kind))
    return { id, kind: kind as Card['kind'], title, table_id: table.id, measure: { aggregate: 'count' } };
  if (kind === 'custom') return { id, kind, title, html: '' };
  if (kind === 'button')
    return { id, kind, title, table_id: table.id, action: { id: localId(), name: title, type: 'create', values: {} } };
  return {
    id,
    kind: kind as 'records',
    title,
    table_id: table.id,
    fields: table.fields.filter((f) => !isComputedType(f.type)).map((f) => f.id),
    actions: [],
  };
}
function ActionsEditor({
  table,
  actions,
  onChange,
  onlyCreate,
}: {
  table: BaseTable;
  actions: AppAction[];
  onChange: (actions: AppAction[]) => void;
  onlyCreate?: boolean;
}) {
  const t = useT();
  const { memberById } = usePeople();
  const change = (index: number, value: AppAction) => onChange(actions.map((a, i) => (i === index ? value : a)));
  const fields = table.fields.filter(
    (f) => !isComputedType(f.type) && !['attachment', 'relation', 'parent', 'dependency', 'member'].includes(f.type),
  );
  return (
    <div className="app-stack">
      {actions.map((action, index) => (
        <div className="app-ap-action-edit" key={action.id}>
          <Field label={t('apps.actionName')}>
            <Input value={action.name} onChange={(e) => change(index, { ...action, name: e.target.value })} />
          </Field>
          {!onlyCreate && (
            <FieldGroup label={t('apps.actionType')}>
              <Select
                label={t('apps.actionType')}
                value={action.type}
                options={[
                  { value: 'create', label: t('apps.createRecord') },
                  { value: 'update', label: t('apps.updateRecord') },
                ]}
                onChange={(value) => change(index, { ...action, type: value as AppAction['type'] })}
              />
            </FieldGroup>
          )}
          <FieldGroup label={t('apps.actionField')}>
            <MultiSelect
              label={t('apps.actionField')}
              value={Object.keys(action.values)}
              options={fields.map((f) => ({ value: f.id, label: f.name }))}
              onChange={(ids) =>
                change(index, { ...action, values: Object.fromEntries(ids.map((id) => [id, action.values[id] ?? ''])) })
              }
            />
          </FieldGroup>
          {Object.entries(action.values).map(([id, value]) => {
            const field = fields.find((f) => f.id === id);
            return field ? (
              <FieldGroup key={id} label={field.name}>
                <FieldInput
                  field={field}
                  value={value}
                  baseId={table.base_id}
                  lookups={{ members: memberById, linked: {}, files: {}, timeZone: 'Asia/Shanghai' }}
                  onChange={(next) => change(index, { ...action, values: { ...action.values, [id]: next } })}
                />
              </FieldGroup>
            ) : null;
          })}
          {!onlyCreate && (
            <Button onClick={() => onChange(actions.filter((a) => a.id !== action.id))}>{t('apps.delete')}</Button>
          )}
        </div>
      ))}
      {!onlyCreate && (
        <Button
          onClick={() => onChange([...actions, { id: localId(), name: t('apps.execute'), type: 'update', values: {} }])}
        >
          {t('apps.addAction')}
        </Button>
      )}
    </div>
  );
}
export function AppCardEditor({
  base,
  initial,
  onSave,
  onClose,
}: {
  base: Base;
  initial: AppCard;
  onSave: (card: AppCard) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [card, setCard] = useState(initial);
  const formId = useId();
  if (CHARTS.includes(card.kind))
    return (
      <ChartEditor
        base={base}
        card={card as Card}
        isNew={false}
        onClose={onClose}
        onSave={async (card) => {
          onSave(card);
          return null;
        }}
      />
    );
  const table = 'table_id' in card ? base.tables.find((t) => t.id === card.table_id) : undefined;
  const fields = table?.fields.filter((f) => card.kind !== 'form' || !isComputedType(f.type)) ?? [];
  const normalizeAction = (action: AppAction): AppAction => ({
    ...action,
    values: Object.fromEntries(
      Object.entries(action.values).map(([id, value]) => {
        const field = table?.fields.find((f) => f.id === id);
        return [id, field ? fromText(field, value) : value];
      }),
    ),
  });
  const set = (patch: Partial<AppCard>) => setCard({ ...card, ...patch } as AppCard);
  return (
    <Overlay variant="drawer" title={t('apps.editCard')} onClose={onClose}>
      <form
        className="app-form"
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          onSave(
            'actions' in card
              ? { ...card, actions: card.actions.map(normalizeAction) }
              : 'action' in card
                ? { ...card, action: normalizeAction(card.action) }
                : card,
          );
        }}
      >
        <Field label={t('apps.cardTitle')}>
          <Input value={card.title} required maxLength={100} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        {card.kind === 'custom' ? (
          <>
            <p>{t('apps.customDisabled')}</p>
            <Field label={t('apps.html')}>
              <TextArea
                rows={12}
                value={card.html}
                maxLength={200000}
                onChange={(e) => set({ html: e.target.value })}
              />
            </Field>
          </>
        ) : (
          <>
            <FieldGroup label={t('apps.table')}>
              <Select
                label={t('apps.table')}
                value={card.table_id}
                options={base.tables.map((t) => ({ value: t.id, label: t.name }))}
                onChange={(id) => {
                  const target = base.tables.find((t) => t.id === id)!;
                  set({ ...newCard(card.kind, { ...base, tables: [target] }, card.title), id: card.id });
                }}
              />
            </FieldGroup>
            {'fields' in card && (
              <>
                <FieldGroup label={t('apps.fields')}>
                  <MultiSelect
                    label={t('apps.fields')}
                    value={card.fields}
                    options={fields.map((f) => ({ value: f.id, label: f.name }))}
                    onChange={(fields) => set({ fields })}
                  />
                </FieldGroup>
                {card.kind !== 'form' && (
                  <FieldGroup label={t('apps.detailFields')}>
                    <MultiSelect
                      label={t('apps.detailFields')}
                      value={card.detail_fields ?? card.fields}
                      options={fields.map((f) => ({ value: f.id, label: f.name }))}
                      onChange={(detail_fields) => set({ detail_fields })}
                    />
                  </FieldGroup>
                )}
                {card.kind === 'kanban' && (
                  <FieldGroup label={t('apps.group')}>
                    <Select
                      label={t('apps.group')}
                      value={card.group_field ?? ''}
                      options={fields
                        .filter((f) => f.type === 'single_select' || f.type === 'checkbox')
                        .map((f) => ({ value: f.id, label: f.name }))}
                      onChange={(group_field) => set({ group_field })}
                    />
                  </FieldGroup>
                )}
                <CardFilter fields={fields} filter={card.filter} onChange={(filter) => set({ filter })} />
                {card.kind !== 'form' && table && (
                  <FieldGroup label={t('apps.action')}>
                    <ActionsEditor table={table} actions={card.actions} onChange={(actions) => set({ actions })} />
                  </FieldGroup>
                )}
              </>
            )}
            {card.kind === 'button' && table && (
              <ActionsEditor
                onlyCreate
                table={table}
                actions={[card.action]}
                onChange={(actions) => set({ action: actions[0]! })}
              />
            )}
          </>
        )}
      </form>
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button kind="primary" type="submit" form={formId} disabled={!card.title.trim()}>
          {t('common.save')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}
