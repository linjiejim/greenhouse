/**
 * 画册 (TBL-03): a card per record — the first picture of the cover field on top when the record
 * has one, then its title and up to four more fields. A grouped view gets a heading per group.
 */

import '../../styles/tables-boards.css';
import { useMemo, useState } from 'react';
import { Button } from '@greenhouse/ui/kit';
import type { Field, RecordFile, SystemField, TableRecord } from '@greenhouse/contract';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { MemberAvatar } from '../../shell/MemberAvatar';
import { CellValue } from './cells';
import { CardFields, NoRecords, cardOpeners } from './Kanban';
import { groupRecords, resolveField, titleOf, type CellLookups, type RecordGroup } from './model';
import { GALLERY_PAGE, cardFields, coverField, coverOf, moreCount } from './boards-model';
import type { ViewProps } from './types';

export function GalleryView(props: ViewProps) {
  const { fields, config, data, lookups, onOpen } = props;
  const { t } = useI18n();
  const [limit, setLimit] = useState(GALLERY_PAGE);
  const cover = coverField(fields, config);
  const shownFields = useMemo(() => cardFields(fields, config, [cover?.id]), [fields, config, cover?.id]);
  const groupBy = resolveField(fields, config.group?.field);
  const groups = useMemo<RecordGroup[]>(
    () => (groupBy ? groupRecords(data.items, groupBy) : [{ key: '', records: data.items }]),
    [groupBy, data.items],
  );
  if (!data.items.length) return <NoRecords {...props} />;

  const fileOf = (id: string) => lookups.files[id] ?? data.files[id];
  // At most `limit` cards, filled group by group.
  let left = limit;
  const sections = groups.flatMap((group, index) => {
    if (left <= 0) return [];
    const records = group.records.slice(0, left);
    left -= records.length;
    return [{ group, records, index }];
  });
  const more = moreCount(data.items.length, limit, GALLERY_PAGE);
  return (
    <div className="app-tb-gal" role="group" aria-label={t('tables.gallery.label')}>
      {sections.map(({ group, records, index }) => (
        <section key={`${index}:${group.key}`} className="app-tb-gal-section">
          {groupBy && (
            <h2 className="app-tb-gal-group">
              <GroupLabel field={groupBy} group={group} lookups={lookups} />
              <span className="app-tb-gal-count">{group.records.length}</span>
            </h2>
          )}
          <div className="app-tb-gal-grid">
            {records.map((record) => (
              <GalleryCard
                key={record.id}
                record={record}
                fields={fields}
                shown={shownFields}
                image={coverOf(record, cover, fileOf)}
                lookups={lookups}
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      ))}
      {more > 0 && (
        <Button className="app-tb-gal-more" onClick={() => setLimit((current) => current + GALLERY_PAGE)}>
          {t('tables.gallery.more', { count: more })}
        </Button>
      )}
    </div>
  );
}

function GalleryCard({
  record,
  fields,
  shown,
  image,
  lookups,
  onOpen,
}: {
  record: TableRecord;
  fields: readonly Field[];
  shown: readonly Field[];
  image: RecordFile | undefined;
  lookups: CellLookups;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  /** A picture that did not load (its signed address ran out): no cover until a new address comes. */
  const [broken, setBroken] = useState<string | null>(null);
  const title = titleOf(fields, record);
  const name = title || t('tables.record.untitled');
  return (
    <article
      className="app-tb-gal-card"
      tabIndex={0}
      aria-label={name}
      data-record={record.id}
      {...cardOpeners(() => onOpen(record.id))}
    >
      {image && image.url !== broken && (
        <div className="app-tb-gal-cover">
          <img
            src={image.url}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setBroken(image.url)}
          />
        </div>
      )}
      <div className="app-tb-gal-body">
        <span className={cx('app-tb-gal-title', !title && 'is-untitled')}>{name}</span>
        <CardFields record={record} fields={shown} lookups={lookups} />
      </div>
    </article>
  );
}

/** A group's value: an option, a person, a day, a word; 「（空）」 for none. */
function GroupLabel({
  field,
  group,
  lookups,
}: {
  field: Field | SystemField;
  group: RecordGroup;
  lookups: CellLookups;
}) {
  const { t } = useI18n();
  if (typeof field !== 'string' && field.type === 'checkbox') {
    return <span>{t(group.key === 'true' ? 'tables.checked' : 'tables.unchecked')}</span>;
  }
  if (!group.key) return <span className="app-tb-gal-none">{t('tables.grid.groupEmpty')}</span>;
  if (typeof field === 'string' || field.type === 'member') {
    const member = lookups.members.get(group.key);
    const name = member?.name ?? t('tables.activity.someone');
    return (
      <span className="app-tb-person">
        <MemberAvatar name={name} url={member?.avatar_url} size={20} />
        <span>{name}</span>
      </span>
    );
  }
  return <CellValue field={field} value={group.records[0]?.values[field.id]} lookups={lookups} />;
}
