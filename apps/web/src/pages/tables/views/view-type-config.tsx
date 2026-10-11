/**
 * The settings a view type needs, edited the same way in the create-view and
 * view-settings dialogs: kanban lanes + cover, calendar start / end, gallery
 * cover + fit, grid grouping + row height. Candidate fields mirror the
 * server's `normalizeViewConfig` (packages/db services/tables/views.ts), which
 * remains the authority.
 */

import {
  TABLE_SYSTEM_FIELDS,
  TABLE_VIEW_ROW_HEIGHTS,
  TABLE_VIEW_TYPES,
  type TableFieldType,
  type TableGroupBy,
  type TableViewConfig,
  type TableViewType,
} from '@greenhouse/types/tables';
import { FilterPills, Select } from '../../../components/ui';
import { FormField, FormGrid } from '../../../components/form';
import { SYSTEM_FIELD_LABEL_KEYS } from '../../../components/tables/field-types';
import type { TableField } from '../../../lib/api/tables';
import { useT, type TranslationKey } from '../../../lib/i18n';
import { TABLE_VIEW_TYPE_LABEL_KEYS } from './view-type-meta';

const LANE_TYPES: ReadonlySet<TableFieldType> = new Set(['single_select', 'user']);
const DATE_TYPES: ReadonlySet<TableFieldType> = new Set(['date', 'datetime']);
const COVER_TYPES: ReadonlySet<TableFieldType> = new Set(['attachment']);
const GROUPABLE_TYPES: ReadonlySet<TableFieldType> = new Set([
  'text',
  'number',
  'boolean',
  'date',
  'datetime',
  'single_select',
  'user',
  'url',
  'email',
  'phone',
  'formula',
  'rollup',
]);

const ROW_HEIGHT_LABEL_KEYS: Record<NonNullable<TableViewConfig['rowHeight']>, TranslationKey> = {
  short: 'tables.views.rowHeightShort',
  medium: 'tables.views.rowHeightMedium',
  tall: 'tables.views.rowHeightTall',
};

function candidates(fields: readonly TableField[], types: ReadonlySet<TableFieldType>): TableField[] {
  return fields.filter((field) => types.has(field.type));
}

/** Why `config` cannot be saved as a `type` view, or null when it can. */
export function viewTypeConfigProblem(
  type: TableViewType,
  config: TableViewConfig,
  fields: readonly TableField[],
): TranslationKey | null {
  if (type === 'kanban' && !candidates(fields, LANE_TYPES).some((field) => field.id === config.kanban?.groupFieldId)) {
    return candidates(fields, LANE_TYPES).length === 0
      ? 'tables.views.noLaneCandidates'
      : 'tables.views.chooseLaneField';
  }
  if (
    type === 'calendar' &&
    !candidates(fields, DATE_TYPES).some((field) => field.id === config.calendar?.startFieldId)
  ) {
    return candidates(fields, DATE_TYPES).length === 0
      ? 'tables.views.noDateCandidates'
      : 'tables.views.chooseDateField';
  }
  return null;
}

/** `config` with the type's required settings filled from the first candidate field when missing. */
export function withTypeDefaults(
  type: TableViewType,
  config: TableViewConfig,
  fields: readonly TableField[],
): TableViewConfig {
  if (type === 'kanban' && !config.kanban?.groupFieldId) {
    const lane = candidates(fields, LANE_TYPES)[0];
    return lane ? { ...config, kanban: { ...config.kanban, groupFieldId: lane.id } } : config;
  }
  if (type === 'calendar' && !config.calendar?.startFieldId) {
    const start = candidates(fields, DATE_TYPES)[0];
    return start ? { ...config, calendar: { ...config.calendar, startFieldId: start.id } } : config;
  }
  return config;
}

function groupByValue(groupBy: TableGroupBy | undefined): string {
  if (groupBy?.systemField) return `system:${groupBy.systemField}`;
  if (groupBy?.fieldId) return `field:${groupBy.fieldId}`;
  return '';
}

function parseGroupBy(value: string): TableGroupBy | undefined {
  const [kind, ref] = value.split(':');
  if (kind === 'system' && (TABLE_SYSTEM_FIELDS as readonly string[]).includes(ref ?? '')) {
    return { systemField: ref as TableGroupBy['systemField'] };
  }
  if (kind === 'field' && Number(ref) > 0) return { fieldId: Number(ref) };
  return undefined;
}

const optionalId = (value: string) => (value ? Number(value) : undefined);

export function ViewTypePicker({ value, onChange }: { value: TableViewType; onChange: (type: TableViewType) => void }) {
  const t = useT();
  return (
    <FilterPills
      variant="segment"
      fill
      items={TABLE_VIEW_TYPES.map((type) => ({ key: type, label: t(TABLE_VIEW_TYPE_LABEL_KEYS[type]) }))}
      activeKey={value}
      onChange={(key) => key && onChange(key as TableViewType)}
    />
  );
}

export function ViewTypeConfigFields({
  type,
  config,
  fields,
  onChange,
}: {
  type: TableViewType;
  config: TableViewConfig;
  fields: readonly TableField[];
  onChange: (config: TableViewConfig) => void;
}) {
  const t = useT();
  const none = <option value="">{t('tables.views.none')}</option>;
  const fieldOptions = (types: ReadonlySet<TableFieldType>, except?: number) =>
    candidates(fields, types)
      .filter((field) => field.id !== except)
      .map((field) => (
        <option key={field.id} value={field.id}>
          {field.name}
        </option>
      ));

  if (type === 'kanban') {
    const kanban = config.kanban;
    return (
      <FormGrid>
        <FormField label={t('tables.views.laneField')} help={t('tables.views.laneFieldHelp')} required>
          <Select
            value={kanban?.groupFieldId ?? ''}
            onChange={(event) =>
              onChange({
                ...config,
                // New lanes: the hidden ones belonged to the old field.
                kanban: { groupFieldId: Number(event.target.value), coverFieldId: kanban?.coverFieldId },
              })
            }
          >
            {!kanban?.groupFieldId && <option value="">{t('tables.views.chooseField')}</option>}
            {fieldOptions(LANE_TYPES)}
          </Select>
        </FormField>
        <FormField label={t('tables.views.coverField')}>
          <Select
            value={kanban?.coverFieldId ?? ''}
            onChange={(event) =>
              onChange({
                ...config,
                kanban: { ...kanban!, coverFieldId: optionalId(event.target.value) },
              })
            }
            disabled={!kanban?.groupFieldId}
          >
            {none}
            {fieldOptions(COVER_TYPES)}
          </Select>
        </FormField>
      </FormGrid>
    );
  }

  if (type === 'calendar') {
    const calendar = config.calendar;
    return (
      <FormGrid>
        <FormField label={t('tables.views.startField')} required>
          <Select
            value={calendar?.startFieldId ?? ''}
            onChange={(event) => {
              const startFieldId = Number(event.target.value);
              const endFieldId = calendar?.endFieldId === startFieldId ? undefined : calendar?.endFieldId;
              onChange({ ...config, calendar: { startFieldId, endFieldId } });
            }}
          >
            {!calendar?.startFieldId && <option value="">{t('tables.views.chooseField')}</option>}
            {fieldOptions(DATE_TYPES)}
          </Select>
        </FormField>
        <FormField label={t('tables.views.endField')} help={t('tables.views.endFieldHelp')}>
          <Select
            value={calendar?.endFieldId ?? ''}
            onChange={(event) =>
              onChange({ ...config, calendar: { ...calendar!, endFieldId: optionalId(event.target.value) } })
            }
            disabled={!calendar?.startFieldId}
          >
            {none}
            {fieldOptions(DATE_TYPES, calendar?.startFieldId)}
          </Select>
        </FormField>
      </FormGrid>
    );
  }

  if (type === 'gallery') {
    const gallery = config.gallery ?? {};
    return (
      <FormGrid>
        <FormField label={t('tables.views.coverField')}>
          <Select
            value={gallery.coverFieldId ?? ''}
            onChange={(event) =>
              onChange({ ...config, gallery: { ...gallery, coverFieldId: optionalId(event.target.value) } })
            }
          >
            {none}
            {fieldOptions(COVER_TYPES)}
          </Select>
        </FormField>
        <FormField label={t('tables.views.coverFit')}>
          <Select
            value={gallery.fit ?? 'cover'}
            onChange={(event) =>
              onChange({ ...config, gallery: { ...gallery, fit: event.target.value as 'cover' | 'contain' } })
            }
          >
            <option value="cover">{t('tables.views.coverFitCover')}</option>
            <option value="contain">{t('tables.views.coverFitContain')}</option>
          </Select>
        </FormField>
      </FormGrid>
    );
  }

  return (
    <FormGrid>
      <FormField label={t('tables.views.groupBy')}>
        <Select
          value={groupByValue(config.groupBy)}
          onChange={(event) => onChange({ ...config, groupBy: parseGroupBy(event.target.value) })}
        >
          <option value="">{t('tables.views.noGrouping')}</option>
          {candidates(fields, GROUPABLE_TYPES).map((field) => (
            <option key={field.id} value={`field:${field.id}`}>
              {field.name}
            </option>
          ))}
          {TABLE_SYSTEM_FIELDS.map((field) => (
            <option key={field} value={`system:${field}`}>
              {t(SYSTEM_FIELD_LABEL_KEYS[field])}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label={t('tables.views.rowHeight')}>
        <Select
          value={config.rowHeight ?? 'short'}
          onChange={(event) =>
            onChange({ ...config, rowHeight: event.target.value as NonNullable<TableViewConfig['rowHeight']> })
          }
        >
          {TABLE_VIEW_ROW_HEIGHTS.map((height) => (
            <option key={height} value={height}>
              {t(ROW_HEIGHT_LABEL_KEYS[height])}
            </option>
          ))}
        </Select>
      </FormField>
    </FormGrid>
  );
}
