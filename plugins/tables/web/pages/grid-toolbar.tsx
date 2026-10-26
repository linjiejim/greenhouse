import { IconButton, SearchInput, Select } from '@greenhouse/web/extension-kit';
import { Columns3, Filter, Plus, Save, Trash2 } from '@greenhouse/web/extension-kit';
import type { TableView } from '../api';
import { useT } from '@greenhouse/web/extension-kit';

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
  onAddField,
  onAddRecord,
}: TablesGridToolbarProps) {
  const t = useT();
  const filterLabel =
    filterCount > 0
      ? t('ext.tables.tables.filterRecordsCount', { count: filterCount })
      : t('ext.tables.tables.filterRecords');

  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-edge px-3 py-2">
      <Select size="sm" inline value={selectedViewId} onChange={(event) => onSelectView(event.target.value)}>
        <option value="">{t('ext.tables.tables.defaultView')}</option>
        {views.map((view) => (
          <option key={view.id} value={view.id}>
            {view.name}
            {view.scope === 'personal' ? t('ext.tables.tables.mineSuffix') : ''}
          </option>
        ))}
      </Select>
      <SearchInput
        value={search}
        onChange={onSearch}
        placeholder={t('ext.tables.tables.searchRecords')}
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
          label={t('ext.tables.tables.saveView')}
          tooltip="top"
          onClick={onSaveView}
          disabled={!canEdit}
          className="sm:h-8 sm:w-8"
        >
          <Save size={14} />
        </IconButton>
        {canEdit && (
          <IconButton
            label={t('ext.tables.tables.recycleBin')}
            tooltip="top"
            onClick={onOpenRecycleBin}
            className="sm:h-8 sm:w-8"
          >
            <Trash2 size={14} />
          </IconButton>
        )}
        {canBuild && (
          <IconButton
            label={t('ext.tables.tables.addField')}
            tooltip="top"
            onClick={onAddField}
            className="sm:h-8 sm:w-8"
          >
            <Columns3 size={14} />
          </IconButton>
        )}
        {canEdit && (
          <IconButton
            label={t('ext.tables.tables.addRecord')}
            tooltip="top"
            onClick={onAddRecord}
            className="bg-accent text-on-accent hover:bg-accent-hover hover:text-on-accent sm:h-8 sm:w-8"
          >
            <Plus size={14} />
          </IconButton>
        )}
      </div>
      {pasting && <span className="text-xs text-fg-faint">{t('ext.tables.tables.validatingPaste')}</span>}
    </div>
  );
}
