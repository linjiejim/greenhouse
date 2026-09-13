/**
 * Drag for the knowledge tree: hit-testing and drop intent on top of the shared
 * pointer sensor (`hooks/use-drag-gesture.ts` — read its header for why nothing
 * here uses HTML5 DnD).
 *
 * The tree needs a richer drop model than a flat list: a row can be a neighbour
 * ("put it next to this") or a container ("put it inside this folder"), and
 * which one depends on where in the row the pointer is. `useListReorder` covers
 * the flat case for everything else.
 */

import { useCallback, useRef, useState } from 'react';
import { useDragGesture, NO_DRAG_ATTR } from '../../../hooks/use-drag-gesture';

export { NO_DRAG_ATTR };

export type TreeNodeKind = 'doc' | 'folder';

/** A row's identity: what it is, and where it sits among its siblings. */
export interface TreeNodeRef {
  kind: TreeNodeKind;
  id: number;
  parentId: number | null;
  index: number;
}

/** An insertion point between siblings: "position `index` of this parent's `group`". */
export interface DropEdge {
  parentId: number | null;
  group: TreeNodeKind;
  index: number;
}

export type DropState = { type: 'into'; folderId: number } | { type: 'edge'; edge: DropEdge } | null;

/** Middle band of a folder row means "drop inside"; the outer thirds mean "next to". */
const INTO_BAND = 0.32;

const NODE_ATTR = 'data-tree-node';

export type DropIntent = 'before' | 'into' | 'after';

/** Which band of a row the pointer is in. Rows with no inside split in half. */
export function resolveIntent(rect: { top: number; height: number }, clientY: number, allowInto: boolean): DropIntent {
  const ratio = (clientY - rect.top) / Math.max(rect.height, 1);
  // Split cleanly in half when there is no inside: the `< band / > 1-band` pair
  // leaves the exact midpoint falling through to 'into', which for a document
  // row is not a target at all — a one-pixel dead stripe down every row.
  if (!allowInto) return ratio < 0.5 ? 'before' : 'after';
  if (ratio < INTO_BAND) return 'before';
  if (ratio > 1 - INTO_BAND) return 'after';
  return 'into';
}

/**
 * The sibling order after moving `draggedId` to `index`. Pure, because the
 * index bookkeeping (removing an item shifts every later position by one) is
 * the part that silently produces an off-by-one.
 */
export function computeOrder(siblingIds: number[], draggedId: number, index: number): number[] {
  const ids = siblingIds.filter((id) => id !== draggedId);
  const from = siblingIds.indexOf(draggedId);
  const target = from >= 0 && from < index ? index - 1 : index;
  ids.splice(Math.max(0, Math.min(target, ids.length)), 0, draggedId);
  return ids;
}

/** True when `next` is the order the list already had (so: don't write). */
export function isSameOrder(current: number[], next: number[]): boolean {
  return current.length === next.length && current.every((id, i) => id === next[i]);
}

interface ParsedRow {
  node: TreeNodeRef;
  /** Folder id when this row can be dropped INTO, else null. */
  into: number | null;
  element: HTMLElement;
}

function parseRow(target: Element | null): ParsedRow | null {
  const row = target?.closest(`[${NODE_ATTR}]`);
  if (!(row instanceof HTMLElement)) return null;
  const [kind, rawId] = (row.getAttribute(NODE_ATTR) ?? '').split(':');
  if ((kind !== 'doc' && kind !== 'folder') || !rawId) return null;
  const parentRaw = row.getAttribute('data-tree-parent');
  const intoRaw = row.getAttribute('data-tree-into');
  return {
    node: {
      kind,
      id: Number(rawId),
      parentId: parentRaw ? Number(parentRaw) : null,
      index: Number(row.getAttribute('data-tree-index') ?? 0),
    },
    into: intoRaw ? Number(intoRaw) : null,
    element: row,
  };
}

export interface TreeDragHandlers {
  /** May the dragged node land inside this folder? */
  canDropInto: (dragged: TreeNodeRef, folderId: number) => boolean;
  onDropInto: (dragged: TreeNodeRef, folderId: number) => void;
  onDropEdge: (dragged: TreeNodeRef, edge: DropEdge) => void;
  /** Hovering a folder mid-drag, so the caller can auto-expand it. */
  onHoverFolder?: (folderId: number) => void;
  onDragEnd?: () => void;
}

export interface TreeDrag {
  dragging: TreeNodeRef | null;
  drop: DropState;
  /** Spread onto a row: makes it both a drag source and a drop target. */
  rowProps: (node: TreeNodeRef, opts?: { into?: number }) => Record<string, unknown>;
  /** True if a drag just finished, so the row's click can be swallowed. */
  didDrag: () => boolean;
}

export function useTreeDrag(handlers: TreeDragHandlers): TreeDrag {
  const [drop, setDrop] = useState<DropState>(null);
  // The drop target is read on pointerup, in the same turn it was last written —
  // a state read there would be one render behind.
  const dropRef = useRef<DropState>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const setDropState = useCallback((next: DropState) => {
    dropRef.current = next;
    setDrop(next);
  }, []);

  const gesture = useDragGesture<TreeNodeRef>({
    onMove: (node, clientX, clientY) => {
      const hit = parseRow(document.elementFromPoint(clientX, clientY));
      if (!hit) {
        setDropState(null);
        return;
      }

      const intent = resolveIntent(hit.element.getBoundingClientRect(), clientY, hit.into != null);
      if (intent === 'into' && hit.into != null) {
        if (!handlersRef.current.canDropInto(node, hit.into)) {
          setDropState(null);
          return;
        }
        setDropState({ type: 'into', folderId: hit.into });
        handlersRef.current.onHoverFolder?.(hit.into);
        return;
      }
      setDropState({
        type: 'edge',
        edge: {
          parentId: hit.node.parentId,
          group: hit.node.kind,
          index: intent === 'after' ? hit.node.index + 1 : hit.node.index,
        },
      });
    },
    onDrop: (node) => {
      const target = dropRef.current;
      if (!target) return;
      if (target.type === 'into') handlersRef.current.onDropInto(node, target.folderId);
      else handlersRef.current.onDropEdge(node, target.edge);
    },
    onEnd: () => {
      setDropState(null);
      handlersRef.current.onDragEnd?.();
    },
  });

  const rowProps = useCallback(
    (node: TreeNodeRef, opts: { into?: number } = {}) => ({
      [NODE_ATTR]: `${node.kind}:${node.id}`,
      'data-tree-parent': node.parentId == null ? '' : String(node.parentId),
      'data-tree-index': String(node.index),
      ...(opts.into != null ? { 'data-tree-into': String(opts.into) } : {}),
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => gesture.start(e, node),
    }),
    [gesture],
  );

  return { dragging: gesture.dragging, drop, rowProps, didDrag: gesture.didDrag };
}
