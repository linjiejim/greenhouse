import { useDraftNavigation } from '../../../lib/useDraftNavigation';
/**
 * Adds or changes one card of a dashboard, in a drawer: its title, kind, data table, what it
 * counts or adds up, what a chart groups by (dates in days, weeks, months…), what a list shows
 * and in what order, its filter and size, with a preview of what it will show. Saving puts the
 * card into the dashboard (the caller saves the view); a failure keeps the draft open.
 */

import { useId, useState } from 'react';
import { ChartColumn, ChartLine, ChartPie, Hash, List, type LucideIcon } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  Field,
  FieldGroup,
  Input,
  MultiSelect,
  Overlay,
  OverlayActions,
  Segmented,
  Select,
  type SelectOption,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import {
  CARD_AGGREGATES,
  CARD_KINDS,
  CARD_SIZES,
  DATE_BUCKETS,
  MAX_CARD_GROUPS,
  MAX_CARD_LIST,
  SYSTEM_FIELDS,
  type Base,
  type Card,
  type CardAggregate,
  type CardKind,
  type DateBucket,
} from '@greenhouse/contract';
import { useCardPreview } from '../../../data/tables-cards';
import { cx } from '../../../lib/cx';
import { useI18n } from '../../../lib/i18n';
import { FieldIcon } from '../cells';
import { CardBody } from './CardBody';
import { CardFilter } from './CardFilter';
import {
  GROUP_SYSTEM_FIELDS,
  cardNeeds,
  cardTitle,
  defaultGroup,
  groupFields,
  groupLimit,
  isChart,
  isDateKind,
  kindOfRef,
  listFields,
  listLimit,
  numberFields,
  sizeOf,
  sortFields,
  switchKind,
  switchTable,
} from './model';

const KIND_ICONS: Record<CardKind, LucideIcon> = {
  number: Hash,
  bar: ChartColumn,
  line: ChartLine,
  pie: ChartPie,
  list: List,
};
/** The limits offered, up to the most a card takes. */
const GROUP_LIMITS = [5, 10, 20, MAX_CARD_GROUPS];
const LIST_LIMITS = [5, 10, 20, MAX_CARD_LIST];
/** Fields a list shows at most after the title (cardSchema). */
const LIST_FIELDS_MAX = 8;

export function CardEditor({
  base,
  card: initial,
  isNew,
  onSave,
  onClose,
}: {
  base: Base;
  card: Card;
  isNew: boolean;
  /** Puts the card into the dashboard and saves it: null when saved, else the words for why not. */
  onSave: (card: Card) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const [draft, setDraft] = useState<Card>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const navigation = useDraftNavigation(dirty, busy, onClose);
  const table = base.tables.find((entry) => entry.id === draft.table_id);
  const fields = table?.fields ?? [];
  const needs = cardNeeds(draft);
  const { title: _title, size: _size, ...shape } = draft;
  const preview = useCardPreview(needs || !table ? null : { ...shape, title: '' });

  const change = (next: Card) => {
    // A chart without a group starts with a sensible one of its table.
    const group =
      isChart(next.kind) && !next.group
        ? defaultGroup(base.tables.find((entry) => entry.id === next.table_id)?.fields ?? [])
        : undefined;
    setDraft(group ? { ...next, group } : next);
    setError('');
  };

  const aggregate = draft.measure?.aggregate ?? 'count';
  const numbers = numberFields(fields);
  const aggregates =
    draft.kind === 'pie' ? CARD_AGGREGATES.filter((entry) => entry === 'count' || entry === 'sum') : CARD_AGGREGATES;
  const fieldOption = (field: (typeof fields)[number]) => ({
    value: field.id,
    label: field.name,
    icon: <FieldIcon type={field.type} />,
  });
  const groupOptions: SelectOption[] = [
    ...groupFields(fields).map(fieldOption),
    ...GROUP_SYSTEM_FIELDS.map((field) => ({ value: field, label: t(`tables.system.${field}`) })),
  ];
  const groupKind = kindOfRef(fields, draft.group?.field);
  const sort = draft.list?.sorts?.[0];
  const sortOptions: SelectOption[] = [
    { value: '', label: t('tables.dashboards.sortNone') },
    ...sortFields(fields).map(fieldOption),
    ...SYSTEM_FIELDS.map((field) => ({ value: field, label: t(`tables.system.${field}`) })),
  ];

  const submit = async () => {
    if (needs || busy) return;
    setBusy(true);
    setError('');
    const problem = await onSave(draft);
    if (problem === null) return onClose();
    setError(problem);
    setBusy(false);
  };

  return (
    <Overlay
      title={isNew ? t('tables.dashboards.addCard') : t('tables.dashboards.editCard')}
      onClose={onClose}
      beforeClose={() => {
        if (busy) return false;
        if (!dirty) return true;
        setAsking(true);
        return false;
      }}
    >
      <form
        id={formId}
        className="app-form app-tb-dash-editor"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={t('tables.dashboards.cardTitle')}>
          <Input
            data-autofocus
            value={draft.title}
            maxLength={100}
            placeholder={cardTitle({ ...draft, title: '' }, table, t)}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </Field>
        <FieldGroup label={t('tables.dashboards.kind')}>
          <div className="app-tb-view-types" role="radiogroup" aria-label={t('tables.dashboards.kind')}>
            {CARD_KINDS.map((kind) => {
              const Icon = KIND_ICONS[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={draft.kind === kind}
                  className={cx('app-tb-view-type', draft.kind === kind && 'is-on')}
                  onClick={() => change(switchKind(draft, kind))}
                >
                  <Icon size={icon.md} strokeWidth={icon.stroke} aria-hidden />
                  <span>{t(`tables.dashboards.kind.${kind}`)}</span>
                </button>
              );
            })}
          </div>
        </FieldGroup>
        <FieldGroup label={t('tables.dashboards.table')}>
          <Select
            label={t('tables.dashboards.table')}
            value={draft.table_id}
            options={base.tables.map((entry) => ({ value: entry.id, label: entry.name }))}
            onChange={(tableId) => change(switchTable(draft, tableId))}
          />
        </FieldGroup>

        {draft.kind !== 'list' && (
          <div className="app-tb-dash-editor-pair">
            <FieldGroup label={t('tables.dashboards.measure')}>
              <Select
                label={t('tables.dashboards.measure')}
                value={aggregate}
                options={aggregates.map((entry) => ({
                  value: entry,
                  label: t(`tables.dashboards.aggregate.${entry}`),
                  ...(entry !== 'count' && !numbers.length
                    ? { disabled: true, description: t('tables.dashboards.noNumberFields') }
                    : {}),
                }))}
                onChange={(next) =>
                  change({
                    ...draft,
                    measure:
                      next === 'count'
                        ? { aggregate: 'count' }
                        : {
                            aggregate: next as CardAggregate,
                            ...(draft.measure?.field
                              ? { field: draft.measure.field }
                              : numbers[0]
                                ? { field: numbers[0].id }
                                : {}),
                          },
                  })
                }
              />
            </FieldGroup>
            {aggregate !== 'count' && (
              <FieldGroup label={t('tables.dashboards.measureField')}>
                <Select
                  label={t('tables.dashboards.measureField')}
                  value={draft.measure?.field ?? ''}
                  options={numbers.map(fieldOption)}
                  onChange={(field) => change({ ...draft, measure: { aggregate, field } })}
                />
              </FieldGroup>
            )}
          </div>
        )}

        {isChart(draft.kind) && (
          <>
            <div className="app-tb-dash-editor-pair">
              <FieldGroup label={t('tables.dashboards.group')}>
                <Select
                  label={t('tables.dashboards.group')}
                  value={draft.group?.field ?? ''}
                  options={groupOptions}
                  onChange={(field) => {
                    const date = isDateKind(kindOfRef(fields, field));
                    change({
                      ...draft,
                      group: {
                        field,
                        ...(date ? { bucket: draft.group?.bucket ?? 'week' } : {}),
                        ...(draft.group?.limit ? { limit: draft.group.limit } : {}),
                      },
                    });
                  }}
                />
              </FieldGroup>
              {draft.group && isDateKind(groupKind) && (
                <FieldGroup label={t('tables.dashboards.bucket')}>
                  <Select
                    label={t('tables.dashboards.bucket')}
                    value={draft.group.bucket ?? 'day'}
                    options={DATE_BUCKETS.map((bucket) => ({
                      value: bucket,
                      label: t(`tables.dashboards.bucket.${bucket}`),
                    }))}
                    onChange={(bucket) =>
                      change({ ...draft, group: { ...draft.group!, bucket: bucket as DateBucket } })
                    }
                  />
                </FieldGroup>
              )}
            </div>
            {draft.group && (
              <FieldGroup label={t('tables.dashboards.limit')}>
                <Select
                  label={t('tables.dashboards.limit')}
                  value={String(groupLimit(draft))}
                  options={[...new Set([...GROUP_LIMITS, groupLimit(draft)])]
                    .sort((a, b) => a - b)
                    .map((count) => ({ value: String(count), label: t('tables.dashboards.limitGroups', { count }) }))}
                  onChange={(next) => change({ ...draft, group: { ...draft.group!, limit: Number(next) } })}
                />
              </FieldGroup>
            )}
          </>
        )}

        {draft.kind === 'list' && (
          <>
            <FieldGroup label={t('tables.dashboards.listFields')}>
              <MultiSelect
                label={t('tables.dashboards.listFields')}
                value={draft.list?.fields ?? []}
                options={listFields(fields).map(fieldOption)}
                onChange={(next) =>
                  change({ ...draft, list: { ...draft.list, fields: next.slice(0, LIST_FIELDS_MAX) } })
                }
              />
            </FieldGroup>
            <div className="app-tb-dash-editor-pair">
              <FieldGroup label={t('tables.dashboards.sort')}>
                <Select
                  label={t('tables.dashboards.sort')}
                  value={sort?.field ?? ''}
                  options={sortOptions}
                  onChange={(field) =>
                    change({
                      ...draft,
                      list: {
                        fields: draft.list?.fields ?? [],
                        ...(draft.list?.limit ? { limit: draft.list.limit } : {}),
                        ...(field ? { sorts: [{ field, ...(sort?.desc ? { desc: true } : {}) }] } : {}),
                      },
                    })
                  }
                />
              </FieldGroup>
              {sort && (
                <FieldGroup label={t('tables.group.order')}>
                  <Segmented
                    label={t('tables.group.order')}
                    items={[
                      { value: 'asc', label: t('tables.sort.asc') },
                      { value: 'desc', label: t('tables.sort.desc') },
                    ]}
                    value={sort.desc ? 'desc' : 'asc'}
                    onChange={(next) =>
                      change({
                        ...draft,
                        list: {
                          fields: draft.list?.fields ?? [],
                          ...(draft.list?.limit ? { limit: draft.list.limit } : {}),
                          sorts: [{ field: sort.field, ...(next === 'desc' ? { desc: true } : {}) }],
                        },
                      })
                    }
                  />
                </FieldGroup>
              )}
            </div>
            <FieldGroup label={t('tables.dashboards.listLimit')}>
              <Select
                label={t('tables.dashboards.listLimit')}
                value={String(listLimit(draft))}
                options={[...new Set([...LIST_LIMITS, listLimit(draft)])]
                  .sort((a, b) => a - b)
                  .map((count) => ({ value: String(count), label: t('tables.dashboards.listLimitN', { count }) }))}
                onChange={(next) =>
                  change({ ...draft, list: { fields: draft.list?.fields ?? [], ...draft.list, limit: Number(next) } })
                }
              />
            </FieldGroup>
          </>
        )}

        <FieldGroup label={t('tables.filter')}>
          <CardFilter fields={fields} filter={draft.filter} onChange={(filter) => change({ ...draft, filter })} />
        </FieldGroup>
        <FieldGroup label={t('tables.dashboards.size')}>
          <Segmented
            label={t('tables.dashboards.size')}
            items={CARD_SIZES.map((size) => ({ value: size, label: t(`tables.dashboards.size.${size}`) }))}
            value={sizeOf(draft)}
            onChange={(size) => setDraft({ ...draft, size: size as Card['size'] })}
          />
        </FieldGroup>

        <section className="app-tb-dash-preview" aria-label={t('tables.dashboards.preview')}>
          <h3 className="app-tb-dash-preview-title">{t('tables.dashboards.preview')}</h3>
          <div className="app-tb-dash-card is-preview">
            <p className="app-tb-dash-card-title">{cardTitle(draft, table, t)}</p>
            {needs ? (
              <p className="app-tb-dash-empty">
                {needs === 'field' ? t('tables.dashboards.needsField') : t('tables.dashboards.needsGroup')}
              </p>
            ) : (
              <CardBody
                card={draft}
                data={
                  !table
                    ? { kind: 'error', code: 'table_hidden' }
                    : preview.isError
                      ? { kind: 'error', code: 'failed' }
                      : preview.data
                }
                baseId={base.id}
                table={table}
                label={cardTitle(draft, table, t)}
              />
            )}
          </div>
        </section>
        {error && (
          <p className="app-tb-dash-editor-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <OverlayActions>
        <Button
          onClick={() => {
            if (busy) return;
            if (dirty) setAsking(true);
            else onClose();
          }}
        >
          {t('common.cancel')}
        </Button>
        <Button
          kind="primary"
          type="submit"
          form={formId}
          loading={busy}
          disabled={!!needs}
          disabledReason={
            needs === 'field'
              ? t('tables.dashboards.needsField')
              : needs === 'group'
                ? t('tables.dashboards.needsGroup')
                : undefined
          }
        >
          {isNew ? t('tables.dashboards.addCard') : t('tables.dashboards.saveCard')}
        </Button>
      </OverlayActions>
      {(asking || navigation.asking) && (
        <ConfirmDialog
          title={t('tables.record.discardTitle')}
          confirmLabel={t('tables.record.discard')}
          danger
          onCancel={() => {
            setAsking(false);
            navigation.cancel();
          }}
          onConfirm={() => {
            setAsking(false);
            if (navigation.asking) navigation.discard();
            else onClose();
          }}
        >
          {t('tables.record.discardBody')}
        </ConfirmDialog>
      )}
    </Overlay>
  );
}
