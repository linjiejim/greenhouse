/**
 * Gallery view body: one card per record — the cover is the first image of
 * `gallery.coverFieldId` (fit `cover` or `contain`), the title the primary
 * field, then the card fields. Paged by the container like the grid.
 */

import { useId } from 'react';
import { Card, EmptyState } from '../../../components/ui';
import { recordFieldValue } from '../../../components/tables/field-value';
import { GalleryHorizontal } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';
import { RecordCover } from './record-cover';
import { cardFields, primaryField, RecordCardFields, RecordTitle } from './record-card';
import type { TableViewBodyProps } from './types';
import { fieldById } from './view-query';

export function GalleryViewBody({
  config,
  fields,
  schemaFields,
  records,
  loading,
  usersById,
  onOpenRecord,
}: TableViewBodyProps) {
  const t = useT();
  /** Each card is named by its title element (screen readers hear the record, not "Record #12"). */
  const cardIdPrefix = useId();
  const cover = fieldById(schemaFields, config.gallery?.coverFieldId);
  const coverField = cover?.type === 'attachment' ? cover : undefined;
  const primary = primaryField(schemaFields);
  const shownFields = cardFields(fields, schemaFields, config, primary);
  const systemFields = config.systemFields ?? [];

  if (records.length === 0 && !loading) {
    return <EmptyState icon={GalleryHorizontal} tone="neutral" title={t('tables.views.galleryEmpty')} />;
  }

  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] content-start gap-3 p-3"
      data-testid="gallery-grid"
    >
      {records.map((record) => (
        <Card
          key={record.id}
          role="button"
          tabIndex={0}
          data-testid={`gallery-card-${record.id}`}
          aria-labelledby={`${cardIdPrefix}-${record.id}`}
          onClick={() => onOpenRecord(record)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onOpenRecord(record);
          }}
          className="cursor-pointer overflow-hidden hover:border-edge-strong"
        >
          {coverField && (
            <RecordCover
              value={recordFieldValue(record, coverField.id)}
              alt=""
              fit={config.gallery?.fit}
              placeholder
              className="aspect-[4/3]"
            />
          )}
          <div className="space-y-2 p-3">
            <p id={`${cardIdPrefix}-${record.id}`} className="truncate text-sm font-medium text-fg">
              <RecordTitle record={record} primary={primary} usersById={usersById} />
            </p>
            <RecordCardFields record={record} fields={shownFields} systemFields={systemFields} usersById={usersById} />
          </div>
        </Card>
      ))}
    </div>
  );
}
