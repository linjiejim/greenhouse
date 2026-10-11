/**
 * A buttons card's buttons (`AppButton[]`): each opens a page of the app, a
 * link (http(s) or an in-app `#/` address — what the validator accepts), or a
 * new-record form on a table (fields to fill, values filled automatically).
 * A card keeps at least one button.
 */

import { useState } from 'react';
import { APP_LIMITS, type AppButton, type AppPage, type AppRole, type AppSpecError } from '@greenhouse/types/apps';
import { Button, IconButton, Input, Select } from '../../../../components/ui';
import { FormField } from '../../../../components/form';
import type { TableDefinition, TableUserOption } from '../../../../lib/api/tables';
import { useT } from '../../../../lib/i18n';
import { ArrowDown, ArrowUp, Plus, Trash2 } from '../../../../lib/icons';
import { prefillableField } from '../../../../components/tables/field-values-editor';
import { actionErrors } from '../spec-errors';
import { fieldsOf, newButtonId, primaryFirst, withList, writableFields, type BuilderSchema } from '../spec-model';
import { FieldListPicker, RolesPicker, SpecErrorList, SpecValuesEditor, TextSetting } from './common';

/** What `open_url` may hold (the validator's rule). */
export const BUTTON_URL_PATTERN = /^(https?:\/\/[^\s]+|#\/[^\s]*)$/i;

type ButtonType = AppButton['type'];

/** The fields a new-record button starts with on a table. */
function startingFields(schema: BuilderSchema, tableId: number): number[] {
  return primaryFirst(writableFields(fieldsOf(schema, tableId)))
    .slice(0, 6)
    .map((field) => field.id);
}

function retype(
  button: AppButton,
  type: ButtonType,
  pages: readonly AppPage[],
  tables: readonly TableDefinition[],
  schema: BuilderSchema,
): AppButton {
  const base = { id: button.id, label: button.label, ...(button.roles ? { roles: button.roles } : {}) };
  if (type === 'open_page') return { ...base, type, pageId: pages[0]!.id };
  if (type === 'open_url') return { ...base, type, url: '#/apps' };
  const tableId = tables[0]!.id;
  return { ...base, type, tableId, fieldIds: startingFields(schema, tableId) };
}

function UrlSetting({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const t = useT();
  const [text, setText] = useState(value);
  const valid = BUTTON_URL_PATTERN.test(text.trim());
  return (
    <FormField
      label={t('apps.builder.buttons.url')}
      help={t('apps.builder.buttons.urlHint')}
      error={valid ? undefined : t('apps.builder.buttons.urlInvalid')}
    >
      <Input
        value={text}
        maxLength={2000}
        onChange={(event) => {
          setText(event.target.value);
          const next = event.target.value.trim();
          if (BUTTON_URL_PATTERN.test(next)) onChange(next);
        }}
      />
    </FormField>
  );
}

export function ButtonsEditor({
  buttons,
  onChange,
  pages,
  roles,
  schema,
  users,
  errors,
}: {
  buttons: readonly AppButton[];
  onChange: (next: AppButton[]) => void;
  pages: readonly AppPage[];
  roles: readonly AppRole[];
  schema: BuilderSchema;
  users: TableUserOption[];
  errors: readonly AppSpecError[];
}) {
  const t = useT();
  const creatable = schema.tables.filter((table) => writableFields(fieldsOf(schema, table.id)).length > 0);
  const update = (index: number, next: AppButton) =>
    onChange(buttons.map((entry, at) => (at === index ? next : entry)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...buttons];
    const [button] = next.splice(index, 1);
    next.splice(index + by, 0, button!);
    onChange(next);
  };

  return (
    <div className="space-y-2" data-testid="app-buttons-editor">
      <ul className="space-y-2">
        {buttons.map((button, index) => {
          const fields = button.type === 'create_record' ? fieldsOf(schema, button.tableId) : [];
          return (
            <li key={button.id} className="space-y-3 rounded-lg border border-edge bg-surface-raised p-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <TextSetting
                    required
                    label={t('apps.builder.buttons.label')}
                    value={button.label}
                    maxLength={APP_LIMITS.nameLength}
                    onChange={(label) => label && update(index, { ...button, label })}
                  />
                </div>
                <div className="mt-6 flex flex-shrink-0">
                  <IconButton
                    label={t('apps.builder.buttons.moveUp', { label: button.label })}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={12} />
                  </IconButton>
                  <IconButton
                    label={t('apps.builder.buttons.moveDown', { label: button.label })}
                    disabled={index === buttons.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={12} />
                  </IconButton>
                  <IconButton
                    variant="destructive"
                    label={t('apps.builder.buttons.remove', { label: button.label })}
                    disabled={buttons.length <= 1}
                    onClick={() => onChange(buttons.filter((_, at) => at !== index))}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              </div>
              <FormField label={t('apps.builder.buttons.type')}>
                <Select
                  value={button.type}
                  onChange={(event) =>
                    update(index, retype(button, event.target.value as ButtonType, pages, creatable, schema))
                  }
                >
                  <option value="open_page">{t('apps.builder.buttons.types.open_page')}</option>
                  <option value="open_url">{t('apps.builder.buttons.types.open_url')}</option>
                  <option value="create_record" disabled={creatable.length === 0 && button.type !== 'create_record'}>
                    {t('apps.builder.buttons.types.create_record')}
                  </option>
                </Select>
              </FormField>
              {button.type === 'open_page' && (
                <FormField label={t('apps.builder.buttons.page')}>
                  <Select
                    value={button.pageId}
                    onChange={(event) => update(index, { ...button, pageId: event.target.value })}
                  >
                    {pages.map((page) => (
                      <option key={page.id} value={page.id}>
                        {page.title}
                      </option>
                    ))}
                  </Select>
                </FormField>
              )}
              {button.type === 'open_url' && (
                <UrlSetting key={button.id} value={button.url} onChange={(url) => update(index, { ...button, url })} />
              )}
              {button.type === 'create_record' && (
                <>
                  <FormField label={t('apps.builder.buttons.table')}>
                    <Select
                      value={button.tableId}
                      onChange={(event) => {
                        // Another table: its fields differ, so the fields and the prefills start over.
                        const tableId = Number(event.target.value);
                        const { defaults: _dropped, ...rest } = button;
                        update(index, { ...rest, tableId, fieldIds: startingFields(schema, tableId) });
                      }}
                    >
                      {creatable.map((table) => (
                        <option key={table.id} value={table.id}>
                          {table.name}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-fg-muted">{t('apps.builder.buttons.fields')}</p>
                    <FieldListPicker
                      label={t('apps.builder.buttons.fields')}
                      fields={writableFields(fields)}
                      value={button.fieldIds}
                      onChange={(fieldIds) => update(index, { ...button, fieldIds })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-fg-muted">{t('apps.builder.buttons.defaults')}</p>
                    <SpecValuesEditor
                      kind="submit"
                      entries={button.defaults}
                      onChange={(defaults) => update(index, withList(button, 'defaults', defaults))}
                      fields={writableFields(fields).filter(
                        (field) => prefillableField(field) && !button.fieldIds.includes(field.id),
                      )}
                      users={users}
                    />
                  </div>
                </>
              )}
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-fg-muted">{t('apps.builder.buttons.roles')}</p>
                <RolesPicker
                  label={t('apps.builder.buttons.roles')}
                  roles={roles}
                  value={button.roles}
                  onChange={(next) => {
                    const updated = { ...button };
                    if (next === undefined) delete updated.roles;
                    else updated.roles = next;
                    update(index, updated);
                  }}
                />
              </div>
              <SpecErrorList errors={actionErrors(errors, button.id)} />
            </li>
          );
        })}
      </ul>
      {buttons.length < APP_LIMITS.buttonsPerCard && (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([
              ...buttons,
              {
                id: newButtonId(buttons),
                label: t('apps.builder.buttons.newLabel'),
                type: 'open_page',
                pageId: pages[0]!.id,
              },
            ])
          }
        >
          <Plus size={13} className="mr-1.5" />
          {t('apps.builder.buttons.add')}
        </Button>
      )}
    </div>
  );
}
