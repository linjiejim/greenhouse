import { IconButton, SearchInput, Select } from '../../components/ui';
import { ClipboardList, Columns3, Filter, Plus, Save, Trash2 } from '../../lib/icons';
import type { TableView } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';

interface TablesGridToolbarProps {
  views: TableView[];
  selectedViewId: string;
  search: string;
  filterCount: number;
  canEdit: boolean;
  canBuild: boolean;
  pasting: boolean;
  onSelectView: (viewId: string) => void;
  onSearch: (value: string) => void;
  onOpenFilters: () => void;
  onSaveView: () => void;
  onOpenRecycleBin: () => void;
  onOpenForms: () => void;
  onAddField: () => void;
  onAddRecord: () => void;
}

export function TablesGridToolbar({
  views,
  selectedViewId,
  search,
  filterCount,
  canEdit,
  canBuild,
  pasting,
  onSelectView,
  onSearch,
  onOpenFilters,
  onSaveView,
  onOpenRecycleBin,
  onOpenForms,
  onAddField,
  onAddRecord,
}: TablesGridToolbarProps) {
  const t = useT();
  const filterLabel =
    filterCount > 0 ? t('tables.filterRecordsCount', { count: filterCount }) : t('tables.filterRecords');

  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-edge px-3 py-2">
      <Select size="sm" inline value={selectedViewId} onChange={(event) => onSelectView(event.target.value)}>
        <option value="">{t('tables.defaultView')}</option>
        {views.map((view) => (
          <option key={view.id} value={view.id}>
            {view.name}
            {view.scope === 'personal' ? t('tables.mineSuffix') : ''}
          </option>
        ))}
      </Select>
      <SearchInput
        value={search}
        onChange={onSearch}
        placeholder={t('tables.searchRecords')}
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
        </IconButton>
        <IconButton
          label={t('tables.saveView')}
          tooltip="top"
          onClick={onSaveView}
          disabled={!canEdit}
          className="sm:h-8 sm:w-8"
        >
          <Save size={14} />
        </IconButton>
        {canEdit && (
          <IconButton label={t('tables.recycleBin')} tooltip="top" onClick={onOpenRecycleBin} className="sm:h-8 sm:w-8">
            <Trash2 size={14} />
          </IconButton>
        )}
        {canBuild && (
          <>
            <IconButton label={t('tables.manageForms')} tooltip="top" onClick={onOpenForms} className="sm:h-8 sm:w-8">
              <ClipboardList size={14} />
            </IconButton>
            <IconButton label={t('tables.addField')} tooltip="top" onClick={onAddField} className="sm:h-8 sm:w-8">
              <Columns3 size={14} />
            </IconButton>
          </>
        )}
        {canEdit && (
          <IconButton
            label={t('tables.addRecord')}
            tooltip="top"
            onClick={onAddRecord}
            className="bg-primary-500 text-white hover:bg-primary-600 hover:text-white sm:h-8 sm:w-8"
          >
            <Plus size={14} />
          </IconButton>
        )}
      </div>
      {pasting && <span className="text-xs text-fg-faint">{t('tables.validatingPaste')}</span>}
    </div>
  );
}
