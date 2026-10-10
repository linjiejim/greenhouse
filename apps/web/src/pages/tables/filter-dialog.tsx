import { useEffect, useState } from 'react';
import type { TableFilterGroup } from '@greenhouse/types/tables';
import { Button, Dialog } from '../../components/ui';
import { FilterEditor } from '../../components/tables/filter-editor';
import { completedFilterGroup } from '../../components/tables/filter-model';
import type { TableField, TableUserOption } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';

/** The view's filter: a draft edited in the shared `FilterEditor`, applied as a whole. */
export function FilterDialog({
  open,
  value,
  fields,
  users,
  onClose,
  onApply,
}: {
  open: boolean;
  value: TableFilterGroup | undefined;
  fields: TableField[];
  users: TableUserOption[];
  onClose: () => void;
  onApply: (group: TableFilterGroup | undefined) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<TableFilterGroup>({ combinator: 'and', clauses: [] });
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setDraft(value ?? { combinator: 'and', clauses: [] });
    setError('');
  }, [open, value]);

  const apply = () => {
    const { group, incompleteIndex } = completedFilterGroup(draft, fields);
    if (incompleteIndex !== null) {
      setError(t('tables.filter.completeEveryCondition'));
      return;
    }
    onApply(group);
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('tables.filterRecords')} size="lg">
      <div className="space-y-4">
        <FilterEditor value={draft} onChange={setDraft} fields={fields} users={users} />
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-edge pt-4">
          <Button variant="ghost" onClick={() => onApply(undefined)}>
            {t('common.clear')}
          </Button>
          <Button onClick={apply}>{t('tables.applyFilters')}</Button>
        </div>
      </div>
    </Dialog>
  );
}
