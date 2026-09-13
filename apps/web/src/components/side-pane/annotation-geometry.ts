/**
 * Coordinate math for the image annotator, kept separate so it is testable
 * without a canvas.
 *
 * Everything is stored in the image's OWN pixel space, never in screen space.
 * The overlay is displayed at whatever size fits the pane, and the export runs
 * at full resolution — if shapes were recorded where the pointer happened to be
 * on screen, every annotation would land somewhere else in the exported file.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Shape =
  | { id: number; kind: 'ellipse'; color: string; cx: number; cy: number; rx: number; ry: number }
  | { id: number; kind: 'rect'; color: string; x: number; y: number; width: number; height: number }
  | { id: number; kind: 'arrow'; color: string; x1: number; y1: number; x2: number; y2: number }
  | { id: number; kind: 'pen'; color: string; points: Point[] }
  | { id: number; kind: 'text'; color: string; x: number; y: number; text: string };

export type ToolKind = Shape['kind'];

/**
 * Map a pointer position to image pixels.
 *
 * `rect` is the rendered `<img>` box. Because the image uses `object-contain`,
 * the rendered box and the image can have different aspect ratios, leaving
 * letterbox bands that are inside the element but outside the picture — the
 * scale has to come from the FITTED size, not from the element size, or every
 * annotation drifts by the size of the bands.
 */
export function toImagePoint(clientX: number, clientY: number, rect: DOMRect, natural: Size): Point {
  const scale = Math.min(rect.width / natural.width, rect.height / natural.height) || 1;
  const renderedWidth = natural.width * scale;
  const renderedHeight = natural.height * scale;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;
  return {
    x: clamp((clientX - rect.left - offsetX) / scale, 0, natural.width),
    y: clamp((clientY - rect.top - offsetY) / scale, 0, natural.height),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Build the shape a drag from `start` to `end` produces for the active tool. */
export function shapeFromDrag(
  kind: Exclude<ToolKind, 'text' | 'pen'>,
  id: number,
  color: string,
  start: Point,
  end: Point,
): Shape {
  if (kind === 'ellipse') {
    return {
      id,
      kind,
      color,
      cx: (start.x + end.x) / 2,
      cy: (start.y + end.y) / 2,
      rx: Math.abs(end.x - start.x) / 2,
      ry: Math.abs(end.y - start.y) / 2,
    };
  }
  if (kind === 'rect') {
    return {
      id,
      kind,
      color,
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
  }
  return { id, kind: 'arrow', color, x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/**
 * Stroke width in image pixels.
 *
 * Derived from the image rather than fixed: 2px is a bold marker on a 400px
 * thumbnail and an invisible hairline on a 4000px scan, and the export is
 * always at full resolution.
 */
export function strokeWidthFor(natural: Size): number {
  return Math.max(2, Math.round(Math.max(natural.width, natural.height) / 250));
}

export function fontSizeFor(natural: Size): number {
  return Math.max(12, Math.round(Math.max(natural.width, natural.height) / 30));
}

/** A drag too small to be intentional — usually a click that meant "place text". */
export function isDegenerateDrag(start: Point, end: Point, natural: Size): boolean {
  const threshold = Math.max(natural.width, natural.height) / 100;
  return Math.abs(end.x - start.x) < threshold && Math.abs(end.y - start.y) < threshold;
}
