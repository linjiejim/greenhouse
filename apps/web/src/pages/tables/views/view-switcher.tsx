/**
 * The view cluster at the start of the Tables toolbar: which view is on screen
 * (its type icon + a select of the table's views), a new view, the fields
 * panel and the view's settings. Buttons appear only where the server would
 * accept the change (`canCreateView`, `canChangeView`).
 */

import { IconButton, Select } from '../../../components/ui';
import { EyeOff, Plus, SlidersHorizontal } from '../../../lib/icons';
import type { TableView } from '../../../lib/api/tables';
import { useT } from '../../../lib/i18n';
import { TABLE_VIEW_TYPE_ICONS, TABLE_VIEW_TYPE_LABEL_KEYS } from './view-type-meta';

export function ViewSwitcher({
  views,
  selectedView,
  canCreateView,
  canChangeView,
  onSelectView,
  onNewView,
  onOpenFields,
  onOpenSettings,
}: {
  views: TableView[];
  selectedView: TableView | null;
  /** Personal views need Base editor. */
  canCreateView: boolean;
  /** The view on screen may be changed (on the default view a change goes through Save view). */
  canChangeView: boolean;
  onSelectView: (viewId: string) => void;
  onNewView: () => void;
  onOpenFields: () => void;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const type = selectedView?.type ?? 'grid';
  const TypeIcon = TABLE_VIEW_TYPE_ICONS[type];

  return (
    <div className="flex items-center gap-1">
      <span
        className="flex h-8 w-6 items-center justify-center text-fg-muted"
        title={t(TABLE_VIEW_TYPE_LABEL_KEYS[type])}
      >
        <TypeIcon size={14} aria-hidden="true" />
      </span>
      <Select
        size="sm"
        inline
        aria-label={t('tables.views.switchView')}
        value={selectedView ? String(selectedView.id) : ''}
        onChange={(event) => onSelectView(event.target.value)}
      >
        <option value="">{t('tables.defaultView')}</option>
        {views.map((view) => (
          <option key={view.id} value={view.id}>
            {view.name}
            {view.scope === 'personal' ? t('tables.mineSuffix') : ''}
          </option>
        ))}
      </Select>
      {canCreateView && (
        <IconButton label={t('tables.views.newView')} tooltip="top" onClick={onNewView} className="sm:h-8 sm:w-8">
          <Plus size={14} />
        </IconButton>
      )}
      {canChangeView && (
        <>
          <IconButton label={t('tables.views.fields')} tooltip="top" onClick={onOpenFields} className="sm:h-8 sm:w-8">
            <EyeOff size={14} />
          </IconButton>
          <IconButton
            label={t('tables.views.viewSettings')}
            tooltip="top"
            onClick={onOpenSettings}
            className="sm:h-8 sm:w-8"
          >
            <SlidersHorizontal size={14} />
          </IconButton>
        </>
      )}
    </div>
  );
}
