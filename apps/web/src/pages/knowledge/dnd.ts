/**
 * Dragging in the knowledge tree and lists (KNOW-01): onto the middle of a folder moves an item
 * into it; onto the top or bottom edge of a row puts it before or after that row (moving it to
 * that row's folder first when it came from another). Files from the computer dropped on a folder
 * upload into it. The server has the last word (cycles, spaces, rights) and says why in a toast.
 */

import { useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { KnowledgeItem } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { refreshTree } from '../../data/knowledge';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { canEdit, canMove, dropPosition, itemKey, reorderAround, type DropPosition } from './helpers';

const DRAG_TYPE = 'application/x-greenhouse-knowledge';

/** The item being dragged (a drag's data is unreadable until the drop, so it is kept here too). */
let dragging: KnowledgeItem | null = null;

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

export function useKnowledgeDnd(options: { onFiles?: (files: File[], folder: KnowledgeItem) => void } = {}) {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const [over, setOver] = useState<{ key: string; position: DropPosition } | null>(null);

  const move = async (item: KnowledgeItem, input: { folder_id: string | null; space?: KnowledgeItem['space'] }) => {
    if (item.type === 'folder') await api.knowledge.folders.update(item.id, input);
    else if (item.type === 'doc') await api.knowledge.docs.update(item.id, input);
    else await api.knowledge.files.update(item.id, input);
  };

  const land = async (
    moving: KnowledgeItem,
    target: KnowledgeItem,
    position: DropPosition,
    siblings: KnowledgeItem[],
  ) => {
    try {
      if (position === 'into') {
        if (target.type !== 'folder' || target.id === moving.id || moving.folder_id === target.id) return;
        await move(moving, { folder_id: target.id });
        notify(t('knowledge.moved', { name: moving.name, place: target.name }));
      } else {
        if (itemKey(target) === itemKey(moving)) return;
        const sameFolder =
          moving.folder_id === target.folder_id && moving.space === target.space && moving.owner_id === target.owner_id;
        if (!sameFolder) {
          await move(
            moving,
            target.folder_id ? { folder_id: target.folder_id } : { folder_id: null, space: target.space },
          );
        }
        await api.knowledge.reorder({
          folder_id: target.folder_id,
          ...(target.folder_id ? {} : { space: target.space }),
          items: reorderAround(siblings, moving, target, position),
        });
      }
    } catch (error) {
      notify(errorText(error, t));
    } finally {
      void refreshTree(client);
      void client.invalidateQueries({ queryKey: ['docs', 'one', moving.id] });
    }
  };

  return {
    /** Who is over which row, and where it would land: rows draw the line or the outline. */
    over,
    /** On an item that can be picked up. */
    source(item: KnowledgeItem) {
      if (!canMove(item)) return {};
      return {
        draggable: true,
        onDragStart: (event: DragEvent<HTMLElement>) => {
          dragging = item;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(DRAG_TYPE, itemKey(item));
          event.dataTransfer.setData('text/plain', item.name);
        },
        onDragEnd: () => {
          dragging = null;
          setOver(null);
        },
      };
    },
    /**
     * On a row that takes drops. `siblings` are the rows of its folder in order (for a reorder);
     * without them only a folder's middle takes drops.
     */
    target(item: KnowledgeItem, siblings?: KnowledgeItem[]) {
      const key = itemKey(item);
      const positionOf = (event: DragEvent<HTMLElement>): DropPosition | null => {
        const rect = event.currentTarget.getBoundingClientRect();
        const files = hasFiles(event);
        if (files) return item.type === 'folder' && canEdit(item) && options.onFiles ? 'into' : null;
        if (!dragging) return null;
        const position = dropPosition(event.clientY - rect.top, rect.height, item.type === 'folder');
        if (position === 'into') return canEdit(item) && dragging.id !== item.id ? 'into' : null;
        return siblings && itemKey(dragging) !== key ? position : null;
      };
      return {
        onDragOver: (event: DragEvent<HTMLElement>) => {
          const position = positionOf(event);
          if (!position) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = hasFiles(event) ? 'copy' : 'move';
          if (over?.key !== key || over.position !== position) setOver({ key, position });
        },
        onDragLeave: (event: DragEvent<HTMLElement>) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setOver((current) => (current?.key === key ? null : current));
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
          const position = positionOf(event);
          setOver(null);
          if (!position) return;
          event.preventDefault();
          event.stopPropagation();
          if (hasFiles(event)) {
            const files = Array.from(event.dataTransfer.files);
            if (files.length) options.onFiles?.(files, item);
            return;
          }
          const moving = dragging;
          dragging = null;
          if (moving) void land(moving, item, position, siblings ?? []);
        },
      };
    },
  };
}
