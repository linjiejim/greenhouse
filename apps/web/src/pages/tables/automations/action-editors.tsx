/**
 * One form per automation action type, plus the shared pieces: the value rows
 * of `update_record` / `create_record` (a field, then a value through the one
 * `FieldEditor`, or a token), and text with `{{field:<id>}}` templates.
 */

import { useId } from 'react';
import { automationTemplateFieldIds, type TableAutomationTrigger } from '@greenhouse/types/tables';
import { Button, Checkbox, IconButton, Input, Select, Textarea } from '../../../components/ui';
import { FormField, FormGrid, FormGroup } from '../../../components/form';
import { FieldEditor } from '../../../components/tables/field-editor';
import { PrincipalPicker } from '../../../components/tables/principal-picker';
import type { TableDefinition, TableField, TableUserOption } from '../../../lib/api/tables';
import { Plus, X } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';
import {
  draftKey,
  TEMPLATE_FIELD_TYPES,
  valueModesFor,
  writableFields,
  type ActionDraft,
  type ValueDraft,
  type ValueMode,
} from './rule-draft';

const MODE_LABEL_KEYS = {
  value: 'tables.automations.values.modeValue',
  $now: 'tables.automations.values.modeNow',
  $today: 'tables.automations.values.modeToday',
  $actor: 'tables.automations.values.modeActor',
} as const satisfies Record<ValueMode, string>;

/** Text that may name fields of the triggering record as `{{field:<id>}}`. */
export function TemplateText({
  label,
  value,
  onChange,
  fields,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** Fields of the triggering record; empty = templates unavailable (no record). */
  fields: readonly TableField[];
  multiline?: boolean;
}) {
  const t = useT();
  const used = automationTemplateFieldIds(value)
    .map((id) => fields.find((field) => field.id === id)?.name ?? `#${id}`)
    .join(', ');
  return (
    <FormField
      label={label}
      help={used ? t('tables.automations.templateUses', { fields: used }) : undefined}
      className="min-w-0"
    >
      {multiline ? (
        <Textarea rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <Input value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </FormField>
  );
}

/** "Insert a field…" — appends `{{field:<id>}}` to a template. */
export function InsertField({
  fields,
  onInsert,
}: {
  fields: readonly TableField[];
  onInsert: (token: string) => void;
}) {
  const t = useT();
  if (fields.length === 0) return null;
  return (
    <Select
      size="sm"
      inline
      value=""
      aria-label={t('tables.automations.insertField')}
      onChange={(event) => {
        if (event.target.value) onInsert(`{{field:${event.target.value}}}`);
      }}
    >
      <option value="">{t('tables.automations.insertField')}</option>
      {fields.map((field) => (
        <option key={field.id} value={field.id}>
          {field.name}
        </option>
      ))}
    </Select>
  );
}

function ValueRow({
  row,
  fields,
  sourceFields,
  usedFieldIds,
  trigger,
  users,
  baseId,
  onChange,
  onRemove,
}: {
  row: ValueDraft;
  fields: readonly TableField[];
  sourceFields: readonly TableField[];
  usedFieldIds: ReadonlySet<number>;
  trigger: TableAutomationTrigger;
  users: TableUserOption[];
  baseId: number;
  onChange: (next: ValueDraft) => void;
  onRemove?: () => void;
}) {
  const t = useT();
  const field = fields.find((candidate) => candidate.id === row.fieldId);
  const modes = valueModesFor(field, trigger);
  const valueId = useId();
  const templatable = field && TEMPLATE_FIELD_TYPES.includes(field.type) && row.mode === 'value';
  return (
    <div className="grid grid-cols-1 gap-2 rounded-md border border-edge bg-surface-raised p-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,9rem)_minmax(0,1fr)_auto] sm:items-start">
      <Select
        size="sm"
        value={row.fieldId ?? ''}
        aria-label={t('tables.automations.values.field')}
        onChange={(event) => {
          const fieldId = event.target.value ? Number(event.target.value) : null;
          onChange({ ...row, fieldId, mode: 'value', draft: '' });
        }}
      >
        <option value="">{t('tables.automations.values.chooseField')}</option>
        {fields.map((candidate) => (
          <option
            key={candidate.id}
            value={candidate.id}
            disabled={candidate.id !== row.fieldId && usedFieldIds.has(candidate.id)}
          >
            {candidate.name}
          </option>
        ))}
      </Select>
      <Select
        size="sm"
        value={row.mode}
        disabled={!field}
        aria-label={t('tables.automations.values.mode')}
        onChange={(event) => onChange({ ...row, mode: event.target.value as ValueMode })}
      >
        {modes.map((mode) => (
          <option key={mode} value={mode}>
            {t(MODE_LABEL_KEYS[mode])}
          </option>
        ))}
      </Select>
      <div className="min-w-0 space-y-1">
        {field && row.mode === 'value' && (
          <>
            <FieldEditor
              id={valueId}
              field={field}
              value={row.draft}
              onChange={(draft) => onChange({ ...row, draft })}
              users={users}
              baseId={baseId}
            />
            {templatable && (
              <InsertField
                fields={sourceFields}
                onInsert={(token) =>
                  onChange({ ...row, draft: `${typeof row.draft === 'string' ? row.draft : ''}${token}` })
                }
              />
            )}
          </>
        )}
      </div>
      {onRemove && (
        <IconButton label={t('tables.automations.values.remove')} size="compact" onClick={onRemove}>
          <X size={14} />
        </IconButton>
      )}
    </div>
  );
}

export function ValuesEditor({
  values,
  fields,
  sourceFields,
  trigger,
  users,
  baseId,
  onChange,
}: {
  values: ValueDraft[];
  /** Fields of the table being written (writable ones are offered). */
  fields: readonly TableField[];
  /** Fields of the triggering record, for templates. */
  sourceFields: readonly TableField[];
  trigger: TableAutomationTrigger;
  users: TableUserOption[];
  baseId: number;
  onChange: (next: ValueDraft[]) => void;
}) {
  const t = useT();
  const writable = writableFields(fields);
  const used = new Set(values.map((row) => row.fieldId).filter((id): id is number => id !== null));
  return (
    <div className="space-y-2">
      {values.map((row, index) => (
        <ValueRow
          key={row.key}
          row={row}
          fields={writable}
          sourceFields={sourceFields}
          usedFieldIds={used}
          trigger={trigger}
          users={users}
          baseId={baseId}
          onChange={(next) => onChange(values.map((candidate, i) => (i === index ? next : candidate)))}
          onRemove={values.length > 1 ? () => onChange(values.filter((_, i) => i !== index)) : undefined}
        />
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={values.length >= writable.length}
        onClick={() => onChange([...values, { key: draftKey(), fieldId: null, mode: 'value', draft: '' }])}
      >
        <Plus size={13} className="mr-1.5" />
        {t('tables.automations.values.add')}
      </Button>
    </div>
  );
}

export function FieldChecklist({
  fields,
  selected,
  onChange,
}: {
  fields: readonly TableField[];
  selected: number[];
  onChange: (next: number[]) => void;
}) {
  return (
    <div className="grid max-h-40 grid-cols-1 gap-1.5 overflow-y-auto rounded-md border border-edge bg-surface-raised p-2 sm:grid-cols-2 lg:grid-cols-3">
      {fields.map((field) => (
        <Checkbox
          key={field.id}
          label={field.name}
          checked={selected.includes(field.id)}
          onChange={(event) =>
            onChange(event.target.checked ? [...selected, field.id] : selected.filter((id) => id !== field.id))
          }
        />
      ))}
    </div>
  );
}

export interface ActionEditorContext {
  trigger: TableAutomationTrigger;
  /** Whether runs have a record (templates, record recipients). */
  hasRecord: boolean;
  /** Whether a member caused the run ($actor, "whoever triggered"). */
  hasActor: boolean;
  /** Fields of the rule's table. */
  fields: readonly TableField[];
  fieldsByTable: ReadonlyMap<number, readonly TableField[]>;
  tables: readonly TableDefinition[];
  users: TableUserOption[];
  baseId: number;
  /** Ask the editor to load a table's fields (create_record targets). */
  needFields: (tableId: number) => void;
}

export function ActionEditor({
  action,
  context,
  onChange,
}: {
  action: ActionDraft;
  context: ActionEditorContext;
  onChange: (next: ActionDraft) => void;
}) {
  const t = useT();
  const templateFields = context.hasRecord ? context.fields : [];
  switch (action.type) {
    case 'update_record':
      return (
        <ValuesEditor
          values={action.values}
          fields={context.fields}
          sourceFields={templateFields}
          trigger={context.trigger}
          users={context.users}
          baseId={context.baseId}
          onChange={(values) => onChange({ ...action, values })}
        />
      );
    case 'create_record': {
      const targetFields = action.tableId === null ? [] : (context.fieldsByTable.get(action.tableId) ?? []);
      return (
        <div className="space-y-3">
          <FormField label={t('tables.automations.targetTable')} className="max-w-sm">
            <Select
              value={action.tableId ?? ''}
              onChange={(event) => {
                const tableId = event.target.value ? Number(event.target.value) : null;
                if (tableId !== null) context.needFields(tableId);
                onChange({
                  ...action,
                  tableId,
                  values: [{ key: draftKey(), fieldId: null, mode: 'value', draft: '' }],
                });
              }}
            >
              <option value="">—</option>
              {context.tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.name}
                </option>
              ))}
            </Select>
          </FormField>
          {action.tableId !== null && (
            <ValuesEditor
              values={action.values}
              fields={targetFields}
              sourceFields={templateFields}
              trigger={context.trigger}
              users={context.users}
              baseId={context.baseId}
              onChange={(values) => onChange({ ...action, values })}
            />
          )}
        </div>
      );
    }
    case 'notify': {
      const personFields = context.fields.filter((field) => field.type === 'user' || field.type === 'multi_user');
      const recipients = action.recipients;
      const setRecipients = (next: Partial<typeof recipients>) =>
        onChange({ ...action, recipients: { ...recipients, ...next } });
      return (
        <div className="space-y-3">
          <FormGroup label={t('tables.automations.notify.recipients')}>
            <PrincipalPicker
              value={{ userIds: recipients.userIds, groupIds: recipients.groupIds }}
              onChange={(next) => setRecipients({ userIds: next.userIds, groupIds: next.groupIds })}
            />
          </FormGroup>
          {(context.hasRecord || context.hasActor) && (
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {context.hasRecord && (
                <Checkbox
                  label={t('tables.automations.notify.creator')}
                  checked={recipients.creator}
                  onChange={(event) => setRecipients({ creator: event.target.checked })}
                />
              )}
              {context.hasActor && (
                <Checkbox
                  label={t('tables.automations.notify.actor')}
                  checked={recipients.actor}
                  onChange={(event) => setRecipients({ actor: event.target.checked })}
                />
              )}
            </div>
          )}
          {context.hasRecord && personFields.length > 0 && (
            <FormGroup label={t('tables.automations.notify.fields')}>
              <FieldChecklist
                fields={personFields}
                selected={recipients.userFieldIds}
                onChange={(userFieldIds) => setRecipients({ userFieldIds })}
              />
            </FormGroup>
          )}
          <div className="space-y-2">
            <TemplateText
              label={t('tables.automations.notify.title')}
              value={action.title}
              fields={templateFields}
              onChange={(title) => onChange({ ...action, title })}
            />
            <TemplateText
              label={t('tables.automations.notify.message')}
              value={action.message}
              fields={templateFields}
              multiline
              onChange={(message) => onChange({ ...action, message })}
            />
            <InsertField
              fields={templateFields}
              onInsert={(token) => onChange({ ...action, message: action.message + token })}
            />
          </div>
          <FormGroup label={t('tables.automations.notify.channels')} help={t('tables.automations.notify.help')}>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <Checkbox
                label={t('tables.automations.notify.im')}
                checked={action.im}
                onChange={(event) => onChange({ ...action, im: event.target.checked })}
              />
              <Checkbox
                label={t('tables.automations.notify.email')}
                checked={action.email}
                onChange={(event) => onChange({ ...action, email: event.target.checked })}
              />
            </div>
          </FormGroup>
        </div>
      );
    }
    case 'webhook':
      return (
        <div className="space-y-3">
          <FormField label={t('tables.automations.webhook.url')} help={t('tables.automations.webhook.urlHelp')}>
            <Input
              type="url"
              value={action.url}
              placeholder="https://"
              onChange={(event) => onChange({ ...action, url: event.target.value })}
            />
          </FormField>
          {context.hasRecord && (
            <FormGroup label={t('tables.automations.webhook.fields')} help={t('tables.automations.webhook.fieldsHelp')}>
              <FieldChecklist
                fields={context.fields}
                selected={action.fieldIds}
                onChange={(fieldIds) => onChange({ ...action, fieldIds })}
              />
            </FormGroup>
          )}
          <WebhookSecret action={action} onChange={onChange} />
        </div>
      );
    case 'delay':
      return (
        <FormGrid>
          <FormField label={t('tables.automations.delay.minutes')} help={t('tables.automations.delay.help')}>
            <Input
              type="number"
              min={1}
              max={1440}
              step={1}
              value={action.minutes}
              onChange={(event) => onChange({ ...action, minutes: event.target.value })}
            />
          </FormField>
        </FormGrid>
      );
  }
}

/** Write-only: the secret is typed here once and never shown again. */
function WebhookSecret({
  action,
  onChange,
}: {
  action: Extract<ActionDraft, { type: 'webhook' }>;
  onChange: (next: ActionDraft) => void;
}) {
  const t = useT();
  const set = (secretAction: typeof action.secretAction) => onChange({ ...action, secretAction, secret: '' });
  return (
    <FormGroup label={t('tables.automations.webhook.secret')} help={t('tables.automations.webhook.secretHelp')}>
      <div className="space-y-2">
        {action.secretAction === 'set' ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="password"
              autoComplete="new-password"
              value={action.secret}
              placeholder={t('tables.automations.webhook.secretPlaceholder')}
              aria-label={t('tables.automations.webhook.secret')}
              onChange={(event) => onChange({ ...action, secret: event.target.value })}
              className="max-w-sm"
            />
            <Button type="button" variant="ghost" size="sm" onClick={() => set('keep')}>
              {action.hasSecret ? t('tables.automations.webhook.keepSecret') : t('common.cancel')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-fg-muted">
              {action.secretAction === 'clear'
                ? t('tables.automations.webhook.secretRemoved')
                : action.hasSecret
                  ? t('tables.automations.webhook.secretSet')
                  : t('tables.automations.webhook.secretNone')}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => set('set')}>
              {action.hasSecret
                ? t('tables.automations.webhook.replaceSecret')
                : t('tables.automations.webhook.setSecret')}
            </Button>
            {action.hasSecret && action.secretAction !== 'clear' && (
              <Button type="button" variant="ghost" size="sm" onClick={() => set('clear')}>
                {t('tables.automations.webhook.removeSecret')}
              </Button>
            )}
            {action.secretAction === 'clear' && (
              <Button type="button" variant="ghost" size="sm" onClick={() => set('keep')}>
                {t('tables.automations.webhook.keepSecret')}
              </Button>
            )}
          </div>
        )}
      </div>
    </FormGroup>
  );
}
