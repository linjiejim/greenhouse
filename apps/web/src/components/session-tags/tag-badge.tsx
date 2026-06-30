/**
 * TagBadge — compact colored tag pill for session items.
 *
 * Sizes:
 *   xs — sidebar session list (minimal, fits tight spaces)
 *   sm — history modal rows, tag filter
 *   md — tag manager dialog, chat header
 */

import React from 'react';
import { X } from '../../lib/icons';

interface TagBadgeProps {
  name: string;
  color: string;
  onRemove?: () => void;
  onClick?: (e: React.MouseEvent) => void;
  size?: 'xs' | 'sm' | 'md';
}

const SIZE_MAP = {
  xs: 'text-[9px] leading-[14px] px-1 py-0 gap-0.5 max-w-[72px]',
  sm: 'text-[10px] leading-[16px] px-1.5 py-0 gap-0.5 max-w-[80px]',
  md: 'text-xs leading-[18px] px-2 py-0.5 gap-1 max-w-[120px]',
};

export function TagBadge({ name, color, onRemove, onClick, size = 'sm' }: TagBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${SIZE_MAP[size]} transition-colors`}
      style={{
        backgroundColor: `${color}20`,
        color: color,
        border: `1px solid ${color}40`,
      }}
      onClick={onClick}
    >
      <span
        className={`rounded-full flex-shrink-0 ${size === 'xs' ? 'w-1 h-1' : 'w-1.5 h-1.5'}`}
        style={{ backgroundColor: color }}
      />
      <span className="truncate" title={name}>
        {name}
      </span>
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="flex-shrink-0 rounded-full hover:opacity-70 transition-opacity"
          title="Remove tag"
        >
          <X size={size === 'xs' ? 8 : 10} />
        </button>
      )}
    </span>
  );
}

/**
 * SessionTagsInline — displays tags inline with "+N" overflow.
 *
 * Reused in sidebar session items and chat detail header.
 */

interface SessionTagsInlineProps {
  tags: Array<{ id: number; name: string; color: string }>;
  /** How many tags to show before "+N" */
  maxVisible?: number;
  size?: 'xs' | 'sm' | 'md';
  /** Called when clicking the "+N" badge or any tag — opens tag editor */
  onEdit?: (e: React.MouseEvent) => void;
  /** Called when removing a tag (only if editable) */
  onRemove?: (tagId: number) => void;
}

export function SessionTagsInline({ tags, maxVisible = 1, size = 'sm', onEdit, onRemove }: SessionTagsInlineProps) {
  if (!tags || tags.length === 0) return null;

  const visible = tags.slice(0, maxVisible);
  const overflow = tags.length - maxVisible;

  return (
    <span className="inline-flex items-center gap-0.5 flex-shrink-0">
      {visible.map((t) => (
        <TagBadge
          key={t.id}
          name={t.name}
          color={t.color}
          size={size}
          onRemove={onRemove ? () => onRemove(t.id) : undefined}
        />
      ))}
      {overflow > 0 && (
        <span
          className={`inline-flex items-center rounded-full font-medium text-fg-muted bg-surface-muted border border-edge cursor-pointer hover:bg-surface-raised transition-colors ${
            size === 'xs' ? 'text-[9px] px-1 py-0' : size === 'sm' ? 'text-[10px] px-1.5 py-0' : 'text-xs px-1.5 py-0.5'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onEdit?.(e);
          }}
          title={tags
            .slice(maxVisible)
            .map((t) => t.name)
            .join(', ')}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
