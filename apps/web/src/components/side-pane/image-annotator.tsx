/**
 * Draw on an image, then ask the model to redo it that way.
 *
 * The point is spatial reference. "Make the thing in the top-left bigger" is a
 * guess the model has to decode; a red circle around it is not. So the output
 * is not a description — it is a second image, flattened, handed to the image
 * model alongside the clean original.
 *
 * Self-drawn SVG rather than a canvas library (spec D1): the vocabulary is five
 * static marks, and konva/fabric would be 100KB+ and a new idiom for that. Same
 * call the workflow DAG made.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Circle, Eraser, Pen, Redo, Send, Square, Type, Undo2 } from '../../lib/icons';
import { Button, IconButton, Spinner, toast } from '../ui';
import { useT } from '../../lib/i18n';
import * as api from '../../lib/api';
import { requestComposerDraft } from '../../lib/composer-draft';
import { useSidePaneStore } from '../../stores/side-pane-store';
import {
  isDegenerateDrag,
  shapeFromDrag,
  toImagePoint,
  type Point,
  type Shape,
  type Size,
  type ToolKind,
} from './annotation-geometry';
import { composeAnnotatedPng, shapesToSvgContent } from './annotation-render';

/** Red first: it is the convention for "look here", and rarely the subject. */
const COLORS = ['#e5484d', '#f5a524', '#2f6fed'];

const TOOLS: Array<{ kind: ToolKind; icon: typeof Circle; labelKey: Parameters<ReturnType<typeof useT>>[0] }> = [
  { kind: 'ellipse', icon: Circle, labelKey: 'annotate.circle' },
  { kind: 'rect', icon: Square, labelKey: 'annotate.box' },
  { kind: 'arrow', icon: ArrowUpRight, labelKey: 'annotate.arrow' },
  { kind: 'pen', icon: Pen, labelKey: 'annotate.pen' },
  { kind: 'text', icon: Type, labelKey: 'annotate.text' },
];

export function ImageAnnotator({ src, imageId }: { src: string; imageId?: string }) {
  const t = useT();
  const closePane = useSidePaneStore((s) => s.close);
  const imageRef = useRef<HTMLImageElement>(null);
  const nextId = useRef(1);
  const dragStart = useRef<Point | null>(null);

  const [natural, setNatural] = useState<Size | null>(null);
  const [tool, setTool] = useState<ToolKind>('ellipse');
  const [color, setColor] = useState(COLORS[0]!);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [redoShapes, setRedoShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [busy, setBusy] = useState(false);

  const overlay = useMemo(
    () => (natural ? shapesToSvgContent(draft ? [...shapes, draft] : shapes, natural) : ''),
    [shapes, draft, natural],
  );

  const pointFrom = useCallback(
    (event: React.PointerEvent): Point | null => {
      const element = imageRef.current;
      if (!element || !natural) return null;
      return toImagePoint(event.clientX, event.clientY, element.getBoundingClientRect(), natural);
    },
    [natural],
  );

  const handlePointerDown = (event: React.PointerEvent) => {
    const point = pointFrom(event);
    if (!point || !natural) return;
    try {
      // Throws NotFoundError when the pointer is already gone. Capture is a
      // nicety (it keeps a drag alive past the element edge); letting it abort
      // pointerdown would mean the stroke never starts at all.
      (event.target as Element).setPointerCapture?.(event.pointerId);
    } catch {
      /* drag still works, it just stops at the element boundary */
    }

    if (tool === 'text') {
      const text = window.prompt(t('annotate.textPrompt'));
      if (text?.trim()) {
        setShapes((prev) => [
          ...prev,
          { id: nextId.current++, kind: 'text', color, x: point.x, y: point.y, text: text.trim() },
        ]);
        setRedoShapes([]);
      }
      return;
    }
    dragStart.current = point;
    if (tool === 'pen') setDraft({ id: nextId.current, kind: 'pen', color, points: [point] });
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!dragStart.current || !natural) return;
    const point = pointFrom(event);
    if (!point) return;
    if (tool === 'pen') {
      setDraft((prev) => (prev && prev.kind === 'pen' ? { ...prev, points: [...prev.points, point] } : prev));
      return;
    }
    setDraft(shapeFromDrag(tool as 'ellipse' | 'rect' | 'arrow', nextId.current, color, dragStart.current, point));
  };

  const handlePointerUp = () => {
    const start = dragStart.current;
    dragStart.current = null;
    if (!draft || !start || !natural) {
      setDraft(null);
      return;
    }
    // A stray click with a shape tool selected would otherwise leave an
    // invisible zero-size mark that Undo has to eat one at a time.
    const tooSmall =
      draft.kind !== 'pen'
        ? isDegenerateDrag(start, { x: endXOf(draft), y: endYOf(draft) }, natural)
        : draft.points.length < 2;
    if (!tooSmall) {
      nextId.current += 1;
      setShapes((prev) => [...prev, draft]);
      setRedoShapes([]);
    }
    setDraft(null);
  };

  const undo = () => {
    const last = shapes[shapes.length - 1];
    if (!last) return;
    setShapes(shapes.slice(0, -1));
    setRedoShapes((prev) => [...prev, last]);
  };

  const redo = () => {
    const last = redoShapes[redoShapes.length - 1];
    if (!last) return;
    setRedoShapes(redoShapes.slice(0, -1));
    setShapes((prev) => [...prev, last]);
  };

  /**
   * Flatten, upload, and stage a turn the user can still edit.
   *
   * BOTH images go: the clean original first (edits use the first image as the
   * base) and the marked-up copy second as spatial reference. Sending only the
   * annotated one would bake the red ink into the result.
   */
  const sendToModel = async () => {
    if (!natural || shapes.length === 0) return;
    setBusy(true);
    try {
      const blob = await composeAnnotatedPng(src, shapes, natural);
      const file = new File([blob], 'annotated.png', { type: 'image/png' });
      const annotated = await api.uploadImage(file);
      const original = imageId ? { id: imageId, url: src } : null;
      requestComposerDraft({
        text: t('annotate.draftPrompt'),
        images: [...(original ? [original] : []), { id: annotated.id, url: annotated.url }],
      });
      closePane();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('annotate.exportFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-1 border-b border-edge px-2 py-1.5">
        {TOOLS.map(({ kind, icon: Icon, labelKey }) => (
          <IconButton
            key={kind}
            label={t(labelKey)}
            size="compact"
            onClick={() => setTool(kind)}
            className={tool === kind ? 'bg-surface-muted text-fg' : ''}
          >
            <Icon size={14} />
          </IconButton>
        ))}
        <span className="mx-1 h-4 w-px bg-edge" />
        {COLORS.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={value}
            onClick={() => setColor(value)}
            style={{ background: value }}
            className={`h-5 w-5 rounded-full border-2 ${color === value ? 'border-fg' : 'border-transparent'}`}
          />
        ))}
        <span className="flex-1" />
        <IconButton label={t('annotate.undo')} size="compact" disabled={shapes.length === 0} onClick={undo}>
          <Undo2 size={14} />
        </IconButton>
        <IconButton label={t('annotate.redo')} size="compact" disabled={redoShapes.length === 0} onClick={redo}>
          <Redo size={14} />
        </IconButton>
        <IconButton
          label={t('annotate.clear')}
          size="compact"
          disabled={shapes.length === 0}
          onClick={() => {
            setShapes([]);
            setRedoShapes([]);
          }}
        >
          <Eraser size={14} />
        </IconButton>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-surface-sunken p-2">
        <div className="relative inline-flex max-h-full max-w-full">
          <img
            ref={imageRef}
            src={src}
            alt={t('annotate.title')}
            draggable={false}
            className="max-h-full max-w-full select-none object-contain"
            onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          />
          {natural && (
            <svg
              viewBox={`0 0 ${natural.width} ${natural.height}`}
              className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              // The markup comes from `shapesToSvgContent`, which builds every
              // attribute from numbers and escapes the one string field.
              dangerouslySetInnerHTML={{ __html: overlay }}
            />
          )}
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center gap-2 border-t border-edge px-3 py-2">
        <span className="flex-1 text-xs text-fg-muted">
          {shapes.length === 0 ? t('annotate.hint') : t('annotate.markCount', { count: shapes.length })}
        </span>
        <Button size="sm" disabled={shapes.length === 0 || busy} onClick={sendToModel}>
          {busy ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : <Send size={13} className="mr-1.5" />}
          {t('annotate.useInChat')}
        </Button>
      </div>
    </div>
  );
}

/** End point of a drag-built shape, for the degenerate-drag check. */
function endXOf(shape: Shape): number {
  if (shape.kind === 'arrow') return shape.x2;
  if (shape.kind === 'rect') return shape.x + shape.width;
  if (shape.kind === 'ellipse') return shape.cx + shape.rx;
  return 0;
}

function endYOf(shape: Shape): number {
  if (shape.kind === 'arrow') return shape.y2;
  if (shape.kind === 'rect') return shape.y + shape.height;
  if (shape.kind === 'ellipse') return shape.cy + shape.ry;
  return 0;
}
