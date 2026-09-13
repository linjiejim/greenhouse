/**
 * TagFilter — horizontal scrollable tag filter bar.
 * A thin wrapper over the shared `FilterPills`: an "All" pill plus one coloured,
 * togglable pill per user tag.
 */

import React from 'react';
import type { SessionTag } from '@greenhouse/types/api';
import { FilterPills } from '../ui';
import { useT } from '../../lib/i18n';

interface TagFilterProps {
  tags: SessionTag[];
  activeTagId: number | null;
  onSelect: (tagId: number | null) => void;
  collapseInSidebar?: boolean;
}

export function TagFilter({ tags, activeTagId, onSelect, collapseInSidebar = false }: TagFilterProps) {
  const t = useT();
  if (tags.length === 0) return null;
  return (
    <FilterPills
      allLabel={t('common.all')}
      toggle
      items={tags.map((tag) => ({ key: String(tag.id), label: tag.name, color: tag.color }))}
      activeKey={activeTagId == null ? null : String(activeTagId)}
      onChange={(key) => onSelect(key == null ? null : Number(key))}
      collapseInSidebar={collapseInSidebar}
      selectLabel={t('sessionGroups.filterByTag')}
    />
  );
}
