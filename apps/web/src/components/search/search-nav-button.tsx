/**
 * Global Search entry point — icon only, tooltip carries the name.
 *
 * Sits immediately left of the Assistant toggle in the sidebar brand row: the two are a matched pair of
 * "reach anything from anywhere" affordances, so they get identical treatment
 * rather than one labelled button beside one bare icon.
 */

import React from 'react';
import { IconButton } from '../ui';
import { Search } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { useGlobalSearchStore } from '../../stores/global-search-store';
import { SEARCH_SHORTCUT_LABEL } from './shortcut';

export function SearchNavButton() {
  const t = useT();
  const toggle = useGlobalSearchStore((s) => s.toggle);
  const isOpen = useGlobalSearchStore((s) => s.isOpen);

  return (
    <IconButton
      label={`${t('search.title')} (${SEARCH_SHORTCUT_LABEL})`}
      tooltip="bottom"
      onClick={toggle}
      className={isOpen ? 'bg-primary-subtle text-primary-fg-strong' : ''}
    >
      <Search size={16} />
    </IconButton>
  );
}
