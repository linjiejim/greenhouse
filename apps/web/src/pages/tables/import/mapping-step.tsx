/**
 * Import wizard · map columns: one line per file column — its name and a few
 * values, where it goes (skip / an existing field / a new field), and for a
 * new field its name and type. Plus the header toggle and, for builders, the
 * "add missing options" switch.
 */

import type { TableImportPreview } from '@greenhouse/types/tables';
import { TABLE_IMPORT_CREATABLE_FIELD_TYPES } from '@greenhouse/types/tables';
import { Checkbox, Input, Select, Toggle } from '../../../components/ui';
import { FIELD_TYPE_LABEL_KEYS } from '../../../components/tables/field-types';
import type { TableField } from '../../../lib/api/tables';
import { useT } from '../../../lib/i18n';
import {
  columnLetter,
  columnSamples,
  destinationFromValue,
  destinationValue,
  importableFields,
  mappedCount,
  type ColumnDestination,
  type ImportCreatableType,
} from './mapping-model';

function creatableType(value: string): ImportCreatableType {
  return TABLE_IMPORT_CREATABLE_FIELD_TYPES.find((type) => type === value) ?? 'text';
}

interface ImportMappingStepProps {
  preview: TableImportPreview;
  fields: TableField[];
  destinations: ColumnDestination[];
  hasHeader: boolean;
  createOptions: boolean;
  canBuild: boolean;
  timeZone: string;
  onDestinationsChange: (destinations: ColumnDestination[]) => void;
  onHasHeaderChange: (value: boolean) => void;
  onCreateOptionsChange: (value: boolean) => void;
}

export function ImportMappingStep({
  preview,
  fields,
  destinations,
  hasHeader,
  createOptions,
  canBuild,
  timeZone,
  onDestinationsChange,
  onHasHeaderChange,
  onCreateOptionsChange,
}: ImportMappingStepProps) {
  const t = useT();
  const targets = importableFields(fields);
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const mapsSelect = destinations.some(
    (destination) =>
      destination.kind === 'field' &&
      ['single_select', 'multi_select'].includes(fieldsById.get(destination.fieldId)?.type ?? ''),
  );

  const update = (index: number, destination: ColumnDestination) =>
    onDestinationsChange(destinations.map((entry, position) => (position === index ? destination : entry)));

  return (
    <div className="space-y-4" data-testid="tables-import-mapping">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-fg-secondary">
          <Toggle size="sm" checked={hasHeader} onChange={onHasHeaderChange} label={t('tables.imports.hasHeader')} />
          {t('tables.imports.hasHeader')}
        </label>
        {canBuild && mapsSelect && (
          <Checkbox
            checked={createOptions}
            onChange={(event) => onCreateOptionsChange(event.target.checked)}
            label={t('tables.imports.createOptions')}
          />
        )}
        <span className="text-xs text-fg-faint">
          {t('tables.imports.mappedCount', { mapped: mappedCount(destinations), total: destinations.length })}
        </span>
      </div>

      <div className="divide-y divide-edge rounded-lg border border-edge">
        <div className="hidden gap-3 bg-surface-muted px-3 py-2 text-xs font-medium text-fg-muted sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)_minmax(0,20rem)]">
          <span>{t('tables.imports.columnHeader')}</span>
          <span>{t('tables.imports.destination')}</span>
          <span />
        </div>
        {preview.columns.map((column, index) => {
          const destination = destinations[index] ?? { kind: 'skip' };
          const title =
            hasHeader && column.header.trim()
              ? column.header
              : t('tables.imports.columnLetter', { letter: columnLetter(index) });
          const samples = columnSamples(column, hasHeader).filter((sample) => sample.trim() !== '');
          return (
            <div
              key={column.index}
              data-testid={`tables-import-column-${index}`}
              className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)_minmax(0,20rem)] sm:items-start sm:gap-3"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-fg" title={title}>
                  {title}
                </div>
                <div
                  className="truncate text-xs text-fg-faint"
                  title={samples.join(' · ') || t('tables.imports.noSamples')}
                >
                  {samples.join(' · ') || t('tables.imports.noSamples')}
                </div>
              </div>
              <Select
                size="sm"
                aria-label={t('tables.imports.destination')}
                data-testid={`tables-import-destination-${index}`}
                value={destinationValue(destination)}
                onChange={(event) => update(index, destinationFromValue(event.target.value, column, destination))}
              >
                <option value="skip">{t('tables.imports.skip')}</option>
                <optgroup label={t('tables.imports.existingFields')}>
                  {targets.map((field) => (
                    <option key={field.id} value={`field:${field.id}`}>
                      {field.name}
                    </option>
                  ))}
                </optgroup>
                {canBuild && <option value="create">{t('tables.imports.newField')}</option>}
              </Select>
              {destination.kind === 'create' ? (
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)] gap-2">
                  <Input
                    size="sm"
                    aria-label={t('tables.imports.newFieldName')}
                    placeholder={t('tables.imports.newFieldName')}
                    data-testid={`tables-import-name-${index}`}
                    value={destination.name}
                    maxLength={120}
                    onChange={(event) => update(index, { ...destination, name: event.target.value })}
                  />
                  <Select
                    size="sm"
                    aria-label={t('tables.imports.newFieldType')}
                    data-testid={`tables-import-type-${index}`}
                    value={destination.type}
                    onChange={(event) => update(index, { ...destination, type: creatableType(event.target.value) })}
                  >
                    {TABLE_IMPORT_CREATABLE_FIELD_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(FIELD_TYPE_LABEL_KEYS[type])}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : (
                <span className="hidden sm:block" />
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-fg-faint">
        {t('tables.imports.timeZoneHint', { zone: timeZone })}
        {canBuild && mapsSelect && !createOptions ? ` ${t('tables.imports.createOptionsHint')}` : ''}
      </p>
    </div>
  );
}
