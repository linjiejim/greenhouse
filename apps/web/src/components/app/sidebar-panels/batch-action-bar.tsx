/**
 * BatchActionBar — sticky footer shown while the chat-history panel is in
 * multi-select mode. Left: selection count + select-all / clear shortcuts.
 * Right: the four batch actions (Tag / Move / Archive / Delete) + Done.
 *
 * Pure presentation: all state lives in the parent panel. Operation buttons
 * disable while `busy` (prevents double-submit) or when nothing is selected;
 * the bar itself stays mounted so the user can always exit.
 */

import React from 'react';
import { Archive, FolderOpen, Tag, Trash2, X } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';

interface BatchActionBarProps {
  count: number;
  busy: boolean;
  onTag: (e: React.MouseEvent) => void;
  onMove: (e: React.MouseEvent) => void;
  onArchive: () => void;
  onDelete: () => void;
  onDone: () => void;
  onSelectAll?: () => void;
  onClear?: () => void;
}

export function BatchActionBar({
  count,
  busy,
  onTag,
  onMove,
  onArchive,
  onDelete,
  onDone,
  onSelectAll,
  onClear,
}: BatchActionBarProps) {
  const t = useT();
  const actionsDisabled = busy || count === 0;

  const actionClass =
    'flex flex-1 flex-col items-center justify-center gap-0.5 min-h-[44px] rounded-md px-1 py-1 text-[10px] font-medium text-fg-secondary transition-colors hover:bg-surface-muted disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div className="sticky bottom-0 z-10 flex-shrink-0 border-t border-edge bg-surface-chrome pb-[max(0.25rem,env(safe-area-inset-bottom))]">
      {/* Count + select-all / clear */}
      <div className="flex items-center gap-2 px-3 pt-2 text-[11px] text-fg-faint">
        <span className="font-medium text-fg-secondary">{t('sessionGroups.selected', { count })}</span>
        <div className="flex-1" />
        {onSelectAll && (
          <button
            type="button"
            onClick={onSelectAll}
            disabled={busy}
            className="rounded px-1.5 py-1 transition-colors hover:text-fg-secondary disabled:opacity-40"
          >
            {t('sessionGroups.selectAll')}
          </button>
        )}
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            disabled={busy || count === 0}
            className="rounded px-1.5 py-1 transition-colors hover:text-fg-secondary disabled:opacity-40"
          >
            {t('sessionGroups.clearSelection')}
          </button>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-stretch gap-1 px-2 pb-1 pt-1">
        <button
          type="button"
          onClick={onTag}
          disabled={actionsDisabled}
          className={actionClass}
          title={t('sessionGroups.batchTag')}
        >
          <Tag size={15} />
          {t('sessionGroups.batchTag')}
        </button>
        <button
          type="button"
          onClick={onMove}
          disabled={actionsDisabled}
          className={actionClass}
          title={t('sessionGroups.moveToGroup')}
        >
          <FolderOpen size={15} />
          {t('sessionGroups.batchMove')}
        </button>
        <button
          type="button"
          onClick={onArchive}
          disabled={actionsDisabled}
          className={actionClass}
          title={t('common.archive')}
        >
          <Archive size={15} />
          {t('common.archive')}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={actionsDisabled}
          className={`${actionClass} text-danger hover:bg-danger-subtle`}
          title={t('common.delete')}
        >
          <Trash2 size={15} />
          {t('common.delete')}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className="flex flex-1 flex-col items-center justify-center gap-0.5 min-h-[44px] rounded-md px-1 py-1 text-[10px] font-medium text-primary-fg-strong transition-colors hover:bg-primary-subtle disabled:opacity-40"
          title={t('sessionGroups.done')}
        >
          <X size={15} />
          {t('sessionGroups.done')}
        </button>
      </div>
    </div>
  );
}
