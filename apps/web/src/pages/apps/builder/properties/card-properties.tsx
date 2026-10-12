import { CustomProperties } from './custom-properties';

import { ExternalProperties } from './external-properties';
/**
 * The properties of one card, per kind (spec §6 构建器 · 属性面板):
 *
 * - records / board / calendar / gallery: data (table, which records, page
 *   filter conditions, order), the fields shown, the kind's own settings
 *   (display; lanes, cover and dragging; start / end; cover), buttons on each
 *   record, the record details (fields, editable fields, comments, buttons in
 *   the details) and — records only — adding records;
 * - form: the table, fields, prefilled values, button text, confirmation, who
 *   may use it;
 * - number / chart / pivot: the dashboard widget editor's settings (shared
 *   `CardSettingsFields`), plus page filter conditions;
 * - text: Markdown; buttons: the buttons editor.
 *
 * Every change goes straight into the spec (autosaved); the server's problems
 * for the card show at the top and next to the action / button they concern.
 */

import { useMemo, useState } from 'react';
import {
  APP_LIMITS,
  type AppCard,
  type AppPage,
  type AppRecordDetail,
  type AppSpec,
  type AppSpecError,
} from '@greenhouse/types/apps';
import type { TableCardKind } from '@greenhouse/types/table-cards';
import type { TableUserOption } from '../../../../lib/api/tables';
import { Checkbox, FilterPills, Select, Textarea, Toggle } from '../../../../components/ui';
import { FormField } from '../../../../components/form';
import { prefillableField } from '../../../../components/tables/field-values-editor';
import { useT } from '../../../../lib/i18n';
import { CardSettingsFields, widgetDraftCard } from '../../../tables/dashboard/card-settings-fields';
import { draftFromCard, type WidgetDraft } from '../../../tables/dashboard/widget-draft';
import { cardErrors } from '../spec-errors';
import {
  appliesTo,
  attachmentFields,
  dateFields,
  eligibleTables,
  fieldsOf,
  laneFields,
  newActionId,
  retargetCard,
  writableFields,
  type BuilderSchema,
  type EmbeddedCard,
  type RecordsLikeCard,
  withList,
} from '../spec-model';
import { ActionsEditor } from './actions-editor';
import { ButtonsEditor } from './buttons-editor';
import {
  ConditionEditor,
  FieldListPicker,
  PanelSection,
  RolesPicker,
  SpecErrorList,
  SpecValuesEditor,
  TextSetting,
} from './common';
import { pageRefClauses, PageRefsEditor, SourceEditor, withQuery } from './source-editor';

interface CardPropertiesProps {
  spec: AppSpec;
  page: AppPage;
  card: AppCard;
  schema: BuilderSchema;
  users: TableUserOption[];
  /** All the draft's problems (this panel picks the card's). */
  errors: readonly AppSpecError[];
  onChange: (next: AppCard) => void;
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3" data-testid={testId}>
      <div className="min-w-0">
        <p className="text-sm text-fg">{label}</p>
        {hint && <p className="text-[11px] leading-4 text-fg-faint">{hint}</p>}
      </div>
      <Toggle size="sm" checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function DetailEditor({
  card,
  onChange,
  context,
}: {
  card: RecordsLikeCard;
  onChange: (next: RecordsLikeCard) => void;
  context: CardPropertiesProps;
}) {
  const t = useT();
  const fields = fieldsOf(context.schema, card.source.tableId);
  const detail = card.detail;
  const setDetail = (next: AppRecordDetail | undefined) => {
    const updated = { ...card };
    if (next) updated.detail = next;
    else delete updated.detail;
    onChange(updated);
  };
  const writable = writableFields(fields);
  const pageRoles = appliesTo(context.spec, context.page.id, undefined);
  const errors = cardErrors(context.errors, context.page.id, card.id);
  const rules = context.schema.buttonRules.filter((rule) => rule.tableId === card.source.tableId);
  return (
    <PanelSection title={t('apps.builder.props.detail')} testId="app-card-detail">
      <ToggleRow
        label={t('apps.builder.props.detailToggle')}
        checked={detail !== undefined}
        onChange={(on) => setDetail(on ? { fieldIds: card.fieldIds } : undefined)}
        testId="app-card-detail-toggle"
      />
      {detail && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-fg-muted">{t('apps.builder.props.detailFields')}</p>
            <FieldListPicker
              label={t('apps.builder.props.detailFields')}
              fields={fields}
              value={detail.fieldIds}
              // A field taken out of the details is no longer editable there either.
              onChange={(fieldIds) =>
                setDetail(
                  withList(
                    { ...detail, fieldIds },
                    'editableFieldIds',
                    (detail.editableFieldIds ?? []).filter((id) => fieldIds.includes(id)),
                  ),
                )
              }
              systemFields={detail.systemFields ?? []}
              onSystemFieldsChange={(systemFields) => setDetail(withList(detail, 'systemFields', systemFields))}
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-fg-muted">{t('apps.builder.props.editable')}</p>
            <p className="text-[11px] leading-4 text-fg-faint">{t('apps.builder.props.editableHint')}</p>
            <div className="space-y-1 rounded-md border border-edge px-3 py-2">
              {writable
                .filter((field) => detail.fieldIds.includes(field.id))
                .map((field) => (
                  <Checkbox
                    key={field.id}
                    label={field.name}
                    checked={(detail.editableFieldIds ?? []).includes(field.id)}
                    onChange={(event) => {
                      const editable = event.target.checked
                        ? [...(detail.editableFieldIds ?? []), field.id]
                        : (detail.editableFieldIds ?? []).filter((id) => id !== field.id);
                      setDetail(withList(detail, 'editableFieldIds', editable));
                    }}
                  />
                ))}
              {!writable.some((field) => detail.fieldIds.includes(field.id)) && (
                <p className="text-xs text-fg-faint">{t('apps.builder.props.nothingEditable')}</p>
              )}
            </div>
          </div>
          <ToggleRow
            label={t('apps.builder.props.comments')}
            hint={t('apps.builder.props.commentsHint')}
            checked={detail.comments === true}
            onChange={(on) => {
              const next = { ...detail };
              if (on) next.comments = true;
              else delete next.comments;
              setDetail(next);
            }}
          />
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-fg-muted">{t('apps.builder.props.detailActions')}</p>
            <ActionsEditor
              actions={detail.actions ?? []}
              onChange={(actions) => setDetail(withList(detail, 'actions', actions))}
              newId={() => newActionId(card)}
              fields={fields}
              users={context.users}
              roles={context.spec.roles}
              pageRoles={pageRoles}
              rules={rules}
              tableId={card.source.tableId}
              errors={errors}
              testId="app-detail-actions"
            />
          </div>
        </div>
      )}
    </PanelSection>
  );
}

function RecordsLikeProperties({ card, context }: { card: RecordsLikeCard; context: CardPropertiesProps }) {
  const t = useT();
  const { schema, spec, page, users, onChange } = context;
  const fields = fieldsOf(schema, card.source.tableId);
  const pageRoles = appliesTo(spec, page.id, undefined);
  const errors = cardErrors(context.errors, page.id, card.id);
  const rules = schema.buttonRules.filter((rule) => rule.tableId === card.source.tableId);
  const set = (next: RecordsLikeCard) => onChange(next);
  const [retargetFailed, setRetargetFailed] = useState(false);

  return (
    <>
      <SourceEditor
        source={card.source}
        onChange={(source) => set({ ...card, source })}
        onTableChange={(tableId) => {
          const next = retargetCard(card, tableId, schema, page.id);
          setRetargetFailed(!next);
          if (next) onChange(next);
        }}
        tables={eligibleTables(card.kind, schema)}
        fields={fields}
        users={users}
        pageFilters={page.filters ?? []}
      />
      {retargetFailed && <p className="text-xs text-danger">{t('apps.builder.props.retargetFailed')}</p>}

      <PanelSection title={t('apps.builder.props.fields')} hint={t('apps.builder.props.fieldsHint')}>
        <FieldListPicker
          label={t('apps.builder.props.fields')}
          fields={fields}
          value={card.fieldIds}
          onChange={(fieldIds) => set({ ...card, fieldIds })}
          testId="app-card-fields"
          {...(card.kind === 'records'
            ? {
                systemFields: card.systemFields ?? [],
                onSystemFieldsChange: (systemFields) => set(withList(card, 'systemFields', systemFields)),
              }
            : {})}
        />
      </PanelSection>

      {card.kind === 'records' && (
        <PanelSection title={t('apps.builder.props.display')}>
          <FilterPills
            variant="segment"
            items={[
              { key: 'table', label: t('apps.builder.props.displayTable') },
              { key: 'list', label: t('apps.builder.props.displayList') },
            ]}
            activeKey={card.display ?? 'table'}
            onChange={(display) => display && set({ ...card, display: display as 'table' | 'list' })}
          />
        </PanelSection>
      )}

      {card.kind === 'kanban' && (
        <PanelSection title={t('apps.builder.props.kanban')}>
          <FormField label={t('apps.builder.props.lane')}>
            <Select
              value={card.groupFieldId}
              onChange={(event) => set({ ...card, groupFieldId: Number(event.target.value) })}
            >
              {laneFields(fields).map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
            </Select>
          </FormField>
          <CoverSelect card={card} fields={fields} onChange={set} />
          <ToggleRow
            label={t('apps.builder.props.move')}
            hint={t('apps.builder.props.moveHint')}
            checked={card.move !== undefined}
            onChange={(on) => {
              const next = { ...card };
              if (on) next.move = {};
              else delete next.move;
              set(next);
            }}
          />
          {card.move && (
            <div className="space-y-3">
              <RolesPicker
                label={t('apps.builder.props.moveRoles')}
                roles={spec.roles}
                value={card.move.roles}
                onChange={(roles) => {
                  const move = { ...card.move };
                  if (roles === undefined) delete move.roles;
                  else move.roles = roles;
                  set({ ...card, move });
                }}
              />
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-fg-muted">{t('apps.builder.props.moveWhen')}</p>
                <ConditionEditor
                  value={card.move.when}
                  onChange={(when) => {
                    const move = { ...card.move };
                    if (when) move.when = when;
                    else delete move.when;
                    set({ ...card, move });
                  }}
                  fields={fields}
                  users={users}
                />
              </div>
            </div>
          )}
        </PanelSection>
      )}

      {card.kind === 'calendar' && (
        <PanelSection title={t('apps.builder.props.calendar')}>
          <FormField label={t('apps.builder.props.start')}>
            <Select
              value={card.startFieldId}
              onChange={(event) => set({ ...card, startFieldId: Number(event.target.value) })}
            >
              {dateFields(fields).map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label={t('apps.builder.props.end')}>
            <Select
              value={card.endFieldId ?? ''}
              onChange={(event) => {
                const next = { ...card };
                if (event.target.value) next.endFieldId = Number(event.target.value);
                else delete next.endFieldId;
                set(next);
              }}
            >
              <option value="">{t('apps.builder.props.noEnd')}</option>
              {dateFields(fields)
                .filter((field) => field.id !== card.startFieldId)
                .map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.name}
                  </option>
                ))}
            </Select>
          </FormField>
        </PanelSection>
      )}

      {card.kind === 'gallery' && (
        <PanelSection title={t('apps.builder.props.gallery')}>
          <CoverSelect card={card} fields={fields} onChange={set} />
        </PanelSection>
      )}

      <PanelSection
        title={t('apps.builder.props.rowActions')}
        hint={t('apps.builder.props.rowActionsHint')}
        defaultOpen={Boolean(card.actions?.length)}
      >
        <ActionsEditor
          actions={card.actions ?? []}
          onChange={(actions) => set(withList(card, 'actions', actions))}
          newId={() => newActionId(card)}
          fields={fields}
          users={users}
          roles={spec.roles}
          pageRoles={pageRoles}
          rules={rules}
          tableId={card.source.tableId}
          errors={errors}
          testId="app-row-actions"
        />
      </PanelSection>

      <DetailEditor card={card} onChange={set} context={context} />

      {card.kind === 'records' && (
        <PanelSection title={t('apps.builder.props.create')} testId="app-card-create">
          <ToggleRow
            label={t('apps.builder.props.createToggle')}
            checked={card.create !== undefined}
            onChange={(on) => {
              const next = { ...card };
              if (on)
                next.create = {
                  fieldIds: writableFields(fields)
                    .slice(0, 6)
                    .map((field) => field.id),
                };
              else delete next.create;
              set(next);
            }}
          />
          {card.create && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-fg-muted">{t('apps.builder.props.createFields')}</p>
                <FieldListPicker
                  label={t('apps.builder.props.createFields')}
                  fields={writableFields(fields)}
                  value={card.create.fieldIds}
                  onChange={(fieldIds) => set({ ...card, create: { ...card.create!, fieldIds } })}
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-fg-muted">{t('apps.builder.props.createDefaults')}</p>
                <SpecValuesEditor
                  kind="submit"
                  entries={card.create.defaults}
                  onChange={(defaults) => set({ ...card, create: withList(card.create!, 'defaults', defaults) })}
                  fields={writableFields(fields).filter(
                    (field) => prefillableField(field) && !card.create!.fieldIds.includes(field.id),
                  )}
                  users={users}
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-fg-muted">{t('apps.builder.props.createRoles')}</p>
                <RolesPicker
                  label={t('apps.builder.props.createRoles')}
                  roles={spec.roles}
                  value={card.create.roles}
                  onChange={(roles) => {
                    const create = { ...card.create! };
                    if (roles === undefined) delete create.roles;
                    else create.roles = roles;
                    set({ ...card, create });
                  }}
                />
              </div>
            </div>
          )}
        </PanelSection>
      )}
    </>
  );
}

function CoverSelect({
  card,
  fields,
  onChange,
}: {
  card: Extract<AppCard, { kind: 'kanban' | 'gallery' }>;
  fields: ReturnType<typeof fieldsOf>;
  onChange: (next: Extract<AppCard, { kind: 'kanban' | 'gallery' }>) => void;
}) {
  const t = useT();
  return (
    <FormField label={t('apps.builder.props.cover')}>
      <Select
        value={card.coverFieldId ?? ''}
        onChange={(event) => {
          const next = { ...card };
          if (event.target.value) next.coverFieldId = Number(event.target.value);
          else delete next.coverFieldId;
          onChange(next);
        }}
      >
        <option value="">{t('apps.builder.props.noCover')}</option>
        {attachmentFields(fields).map((field) => (
          <option key={field.id} value={field.id}>
            {field.name}
          </option>
        ))}
      </Select>
    </FormField>
  );
}

function FormProperties({ card, context }: { card: Extract<AppCard, { kind: 'form' }>; context: CardPropertiesProps }) {
  const t = useT();
  const { schema, spec, page, users, onChange } = context;
  const fields = fieldsOf(schema, card.tableId);
  const writable = writableFields(fields);
  return (
    <>
      <PanelSection title={t('apps.builder.props.source')}>
        <FormField label={t('apps.builder.props.formTable')}>
          <Select
            value={card.tableId}
            onChange={(event) => {
              const next = retargetCard(card, Number(event.target.value), schema, page.id);
              if (next) onChange(next);
            }}
          >
            {eligibleTables('form', schema).map((table) => (
              <option key={table.id} value={table.id}>
                {table.name}
              </option>
            ))}
          </Select>
        </FormField>
      </PanelSection>
      <PanelSection title={t('apps.builder.props.formFields')} hint={t('apps.builder.props.formFieldsHint')}>
        <FieldListPicker
          label={t('apps.builder.props.formFields')}
          fields={writable}
          value={card.fieldIds}
          // A form shows at least one field (the server refuses an empty one).
          minimum={1}
          onChange={(fieldIds) => onChange({ ...card, fieldIds })}
          testId="app-form-fields"
        />
      </PanelSection>
      <PanelSection title={t('apps.builder.props.formDefaults')} hint={t('apps.builder.props.formDefaultsHint')}>
        <SpecValuesEditor
          kind="submit"
          entries={card.defaults}
          onChange={(defaults) => onChange(withList(card, 'defaults', defaults))}
          fields={writable.filter((field) => prefillableField(field) && !card.fieldIds.includes(field.id))}
          users={users}
          testId="app-form-defaults"
        />
      </PanelSection>
      <PanelSection title={t('apps.builder.props.formCopy')}>
        <TextSetting
          label={t('apps.builder.props.submitLabel')}
          placeholder={t('apps.builder.props.submitLabelPlaceholder')}
          value={card.submitLabel}
          maxLength={APP_LIMITS.nameLength}
          onChange={(submitLabel) => {
            const next = { ...card };
            if (submitLabel) next.submitLabel = submitLabel;
            else delete next.submitLabel;
            onChange(next);
          }}
        />
        <TextSetting
          multiline
          rows={2}
          label={t('apps.builder.props.successMessage')}
          placeholder={t('apps.builder.props.successMessagePlaceholder')}
          value={card.successMessage}
          maxLength={500}
          onChange={(successMessage) => {
            const next = { ...card };
            if (successMessage) next.successMessage = successMessage;
            else delete next.successMessage;
            onChange(next);
          }}
        />
      </PanelSection>
      <PanelSection title={t('apps.builder.props.formRoles')}>
        <RolesPicker
          label={t('apps.builder.props.formRoles')}
          roles={spec.roles}
          value={card.roles}
          onChange={(roles) => {
            const next = { ...card };
            if (roles === undefined) delete next.roles;
            else next.roles = roles;
            onChange(next);
          }}
        />
      </PanelSection>
    </>
  );
}

const EMBEDDED_KINDS: readonly TableCardKind[] = ['kpi', 'chart', 'pivot'];

/** Number / chart / pivot: the dashboard widget editor's settings, kept as a draft until they make a valid card. */
function EmbeddedProperties({ card, context }: { card: EmbeddedCard; context: CardPropertiesProps }) {
  const t = useT();
  const { schema, page, users, onChange } = context;
  const [draft, setDraft] = useState<WidgetDraft>(() =>
    draftFromCard(card.card, '', card.card.source?.tableId ?? schema.tables[0]?.id ?? ''),
  );
  const fields = useMemo(() => (draft.tableId === '' ? [] : fieldsOf(schema, draft.tableId)), [draft.tableId, schema]);
  const checked = widgetDraftCard(draft, fields);

  const patch = (change: Partial<WidgetDraft>) => {
    const next = { ...draft, ...change };
    setDraft(next);
    const nextFields = next.tableId === '' ? [] : fieldsOf(schema, next.tableId);
    const result = widgetDraftCard(next, nextFields);
    if (!result.ok) return;
    const kind = result.card.kind;
    if (kind !== 'kpi' && kind !== 'chart' && kind !== 'pivot') return;
    onChange({ ...card, kind, card: result.card } as EmbeddedCard);
  };

  const source = card.card.source;
  return (
    <>
      <PanelSection title={t('apps.builder.props.aggregate')}>
        <div className="space-y-4">
          <CardSettingsFields
            draft={draft}
            patch={patch}
            fields={fields}
            tables={schema.tables}
            users={users}
            kinds={EMBEDDED_KINDS}
            showTitle={false}
            kindLabel={t('apps.builder.props.embeddedKind')}
          />
        </div>
        {!checked.ok && (
          <p className="text-xs text-warning" data-testid="app-embedded-problem">
            {t(checked.problem.key, checked.problem.params)}
          </p>
        )}
      </PanelSection>
      {source && (
        <PanelSection title={t('apps.builder.props.pageRefs')} hint={t('apps.builder.props.pageRefsHint')}>
          <EmbeddedPageRefs
            card={card}
            fields={fields}
            page={page}
            onChange={(next) => {
              const query = next.card.source?.query;
              const { where: _where, ...otherQuery } = query ?? {};
              setDraft((current) => ({ ...current, otherQuery }));
              onChange(next);
            }}
          />
        </PanelSection>
      )}
    </>
  );
}

function EmbeddedPageRefs({
  card,
  fields,
  page,
  onChange,
}: {
  card: EmbeddedCard;
  fields: ReturnType<typeof fieldsOf>;
  page: AppPage;
  onChange: (next: EmbeddedCard) => void;
}) {
  const source = card.card.source!;
  return (
    <PageRefsEditor
      clauses={pageRefClauses(source.query)}
      fields={fields}
      filters={page.filters ?? []}
      onChange={(pageRefs) => onChange({ ...card, card: { ...card.card, source: withQuery(source, { pageRefs }) } })}
    />
  );
}

function TextProperties({
  card,
  onChange,
}: {
  card: Extract<AppCard, { kind: 'text' }>;
  onChange: (next: AppCard) => void;
}) {
  const t = useT();
  return (
    <PanelSection title={t('apps.builder.props.markdown')} hint={t('apps.builder.props.markdownHint')}>
      <Textarea
        rows={10}
        aria-label={t('apps.builder.props.markdown')}
        value={card.markdown}
        maxLength={APP_LIMITS.markdownLength}
        onChange={(event) => onChange({ ...card, markdown: event.target.value })}
        data-testid="app-text-markdown"
      />
    </PanelSection>
  );
}

export function CardProperties(props: CardPropertiesProps) {
  const t = useT();
  const { card, page, spec, schema, users, errors, onChange } = props;
  // Problems of actions and buttons sit next to them; the rest at the top.
  const own = cardErrors(errors, page.id, card.id).filter((error) => !error.actionId);
  return (
    <div className="space-y-4" data-testid="app-card-properties">
      <SpecErrorList errors={own} />
      <TextSetting
        label={t('apps.builder.props.cardTitle')}
        placeholder={t('apps.builder.props.cardTitlePlaceholder')}
        value={card.title}
        maxLength={APP_LIMITS.nameLength}
        testId="app-card-title"
        onChange={(title) => {
          const next = { ...card };
          if (title) next.title = title;
          else delete next.title;
          onChange(next);
        }}
      />
      {(card.kind === 'records' || card.kind === 'kanban' || card.kind === 'calendar' || card.kind === 'gallery') && (
        <RecordsLikeProperties key={`${card.id}:${card.source.tableId}`} card={card} context={props} />
      )}
      {card.kind === 'form' && <FormProperties key={`${card.id}:${card.tableId}`} card={card} context={props} />}
      {(card.kind === 'kpi' || card.kind === 'chart' || card.kind === 'pivot') && (
        <EmbeddedProperties key={card.id} card={card} context={props} />
      )}
      {card.kind === 'custom' && <CustomProperties key={card.id} card={card} schema={schema} onChange={onChange} />}

      {card.kind === 'external' && <ExternalProperties key={card.id} card={card} onChange={onChange} />}
      {card.kind === 'text' && <TextProperties card={card} onChange={onChange} />}
      {card.kind === 'buttons' && (
        <PanelSection title={t('apps.builder.props.buttons')}>
          <ButtonsEditor
            buttons={card.buttons}
            onChange={(buttons) => onChange({ ...card, buttons })}
            pages={spec.pages}
            roles={spec.roles}
            schema={schema}
            users={users}
            errors={cardErrors(errors, page.id, card.id)}
          />
        </PanelSection>
      )}
    </div>
  );
}
