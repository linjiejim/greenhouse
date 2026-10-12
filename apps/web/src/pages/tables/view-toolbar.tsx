import { useCallback, useState, type ReactNode } from 'react';
import { Button, IconButton, SearchInput } from '../../components/ui';
import { ContextMenu, type ContextMenuItem } from '../../components/app/context-menu';
import { ClipboardList, Columns3, FileUp, Filter, MoreHorizontal, Plus, Trash2 } from '../../lib/icons';
import { useT } from '../../lib/i18n';

interface TablesViewToolbarProps {
  /** The view switcher and its actions (`./views/view-switcher.tsx`). */
  viewControls: ReactNode;
  search: string;
  filterCount: number;
  canEdit: boolean;
  canBuild: boolean;
  /** Add records. Defaults to `canEdit` (a custom role may edit without creating, or the reverse). */
  canCreate?: boolean;
  /** The recycle bin needs delete rights. Defaults to `canEdit`. */
  canDelete?: boolean;
  pasting: boolean;
  onSearch: (value: string) => void;
  onOpenFilters: () => void;
  onOpenRecycleBin: () => void;
  onOpenForms: () => void;
  onAddField: () => void;
  onAddRecord: () => void;
  /** Open the CSV / Excel import wizard (shown when given to people who may create records — what the server checks). */
  onImport?: () => void;
}

export function TablesViewToolbar({
  viewControls,
  search,
  filterCount,
  canEdit,
  canBuild,
  canCreate = canEdit,
  canDelete = canEdit,
  pasting,
  onSearch,
  onOpenFilters,
  onOpenRecycleBin,
  onOpenForms,
  onAddField,
  onAddRecord,
  onImport,
}: TablesViewToolbarProps) {
  const t = useT();
  const [menu, setMenu] = useState<{ position: { x: number; y: number }; trigger: HTMLButtonElement } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const moreItems: ContextMenuItem[] = [];
  if (canCreate && onImport)
    moreItems.push({
      label: t('tables.imports.action'),
      icon: FileUp,
      onClick: onImport,
      testId: 'tables-import-open',
    });
  if (canBuild)
    moreItems.push(
      { label: t('tables.manageForms'), icon: ClipboardList, onClick: onOpenForms, testId: 'tables-manage-forms' },
      { label: t('tables.addField'), icon: Columns3, onClick: onAddField, testId: 'tables-add-field' },
    );
  if (canDelete)
    moreItems.push({
      label: t('tables.recycleBin'),
      icon: Trash2,
      onClick: onOpenRecycleBin,
      testId: 'tables-recycle-bin',
    });
  const filterLabel =
    filterCount > 0 ? t('tables.filterRecordsCount', { count: filterCount }) : t('tables.filterRecords');

  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-edge px-3 py-2">
      {viewControls}
      <SearchInput
        value={search}
        onChange={onSearch}
        placeholder={t('tables.searchRecords')}
        size="sm"
        className="min-w-48 flex-1 sm:max-w-xs"
      />
      <div className="flex items-center gap-0.5">
        <IconButton
          label={filterLabel}
          tooltip="top"
          onClick={onOpenFilters}
          className={`sm:h-8 sm:w-8 ${filterCount > 0 ? 'bg-primary-subtle text-primary-fg-strong' : ''}`}
        >
          <Filter size={14} />
          {filterCount > 0 && (
            <span
              className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary-600 px-1 text-[10px] leading-4 text-white"
              aria-hidden="true"
            >
              {filterCount}
            </span>
          )}
        </IconButton>
        {moreItems.length > 0 && (
          <IconButton
            label={t('common.moreActions')}
            tooltip="top"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(event) => {
              const trigger = event.currentTarget;
              const rect = trigger.getBoundingClientRect();
              setMenu(menu ? null : { position: { x: rect.left, y: rect.bottom + 4 }, trigger });
            }}
            className="sm:h-8 sm:w-8"
            data-testid="tables-more-actions"
          >
            <MoreHorizontal size={14} />
          </IconButton>
        )}
        {canCreate && (
          <Button size="sm" onClick={onAddRecord} className="ml-2 min-h-9 gap-1.5 whitespace-nowrap">
            <Plus size={14} />
            {t('tables.addRecord')}
          </Button>
        )}
      </div>
      {pasting && <span className="text-xs text-fg-faint">{t('tables.validatingPaste')}</span>}
      {menu && (
        <ContextMenu items={moreItems} position={menu.position} onClose={closeMenu} returnFocusTo={menu.trigger} />
      )}
    </div>
  );
}
