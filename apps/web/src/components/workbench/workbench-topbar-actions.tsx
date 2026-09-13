/**
 * Customize for the home workbench, rendered by the chat TopBar.
 *
 * The controls sit in the TopBar because the empty state's vertical space
 * belongs to the cards, but they belong to the workbench — so they live here and
 * the TopBar only decides *where*. Null controls means no panel is mounted,
 * which is the one condition for drawing nothing.
 */

import { IconButton } from '../ui';
import { Check, Pencil } from '../../lib/icons';
import { useT } from '../../lib/i18n';

export interface WorkbenchTopBarControls {
  editing: boolean;
  onToggleEdit: () => void;
}

export function WorkbenchTopBarActions({ controls }: { controls: WorkbenchTopBarControls | null }) {
  const t = useT();
  if (!controls) return null;
  const label = controls.editing ? t('home.doneEditing') : t('home.customize');
  return (
    <IconButton
      label={label}
      onClick={controls.onToggleEdit}
      tooltip="bottom"
      aria-pressed={controls.editing}
      className={controls.editing ? 'bg-primary-subtle text-primary-fg-strong hover:bg-primary-subtle-hover' : ''}
    >
      {controls.editing ? <Check size={16} /> : <Pencil size={16} />}
    </IconButton>
  );
}
