/**
 * TagFilter — horizontal scrollable tag filter bar.
 * Shows user's tags as clickable pills, with "All" option.
 */

import React from 'react';
import type { SessionTag } from '@greenhouse/types/api';

interface TagFilterProps {
  tags: SessionTag[];
  activeTagId: number | null;
  onSelect: (tagId: number | null) => void;
}

export function TagFilter({ tags, activeTagId, onSelect }: TagFilterProps) {
  if (tags.length === 0) return null;

  return (
    <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
      <button
        onClick={() => onSelect(null)}
        className={`flex-shrink-0 px-2 py-0.5 text-[11px] rounded-full border transition-colors ${
          activeTagId === null
            ? 'bg-primary-subtle text-primary-fg-strong border-primary-edge font-medium'
            : 'text-fg-muted border-transparent hover:border-edge hover:text-fg-secondary'
        }`}
      >
        All
      </button>
      {tags.map((tag) => {
        const isActive = activeTagId === tag.id;
        return (
          <button
            key={tag.id}
            onClick={() => onSelect(isActive ? null : tag.id)}
            className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full border transition-colors"
            style={
              isActive
                ? {
                    backgroundColor: `${tag.color}20`,
                    color: tag.color,
                    borderColor: `${tag.color}60`,
                  }
                : {
                    backgroundColor: 'transparent',
                    color: undefined,
                    borderColor: 'transparent',
                  }
            }
            onMouseEnter={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLElement).style.borderColor = `${tag.color}40`;
                (e.currentTarget as HTMLElement).style.color = tag.color;
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLElement).style.borderColor = 'transparent';
                (e.currentTarget as HTMLElement).style.color = '';
              }
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
            {tag.name}
          </button>
        );
      })}
    </div>
  );
}
