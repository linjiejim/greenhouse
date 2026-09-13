/**
 * Shapes → SVG markup, and image + shapes → a flat PNG.
 *
 * The same markup serves both the on-screen overlay and the export, so what the
 * user drew is what the model receives. Keeping it as a string (rather than
 * React elements) is what makes the export possible at all: the composite step
 * needs a serializable document to rasterize.
 */

import { fontSizeFor, strokeWidthFor, type Shape, type Size } from './annotation-geometry';

/** Escape for use inside SVG text content or an attribute value. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function shapeMarkup(shape: Shape, stroke: number, fontSize: number): string {
  const common = `fill="none" stroke="${escapeXml(shape.color)}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"`;
  switch (shape.kind) {
    case 'ellipse':
      return `<ellipse cx="${shape.cx}" cy="${shape.cy}" rx="${shape.rx}" ry="${shape.ry}" ${common} />`;
    case 'rect':
      return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" ${common} />`;
    case 'arrow': {
      // The head is drawn as part of the path rather than with a <marker>:
      // markers reference a <defs> id, and ids do not survive being rasterized
      // through an <img> in every browser.
      const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
      const head = Math.max(stroke * 4, 10);
      const left = {
        x: shape.x2 - head * Math.cos(angle - Math.PI / 7),
        y: shape.y2 - head * Math.sin(angle - Math.PI / 7),
      };
      const right = {
        x: shape.x2 - head * Math.cos(angle + Math.PI / 7),
        y: shape.y2 - head * Math.sin(angle + Math.PI / 7),
      };
      return (
        `<path d="M ${shape.x1} ${shape.y1} L ${shape.x2} ${shape.y2}" ${common} />` +
        `<path d="M ${left.x} ${left.y} L ${shape.x2} ${shape.y2} L ${right.x} ${right.y}" ${common} />`
      );
    }
    case 'pen': {
      if (shape.points.length === 0) return '';
      const d = shape.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
      return `<path d="${d}" ${common} />`;
    }
    case 'text':
      return (
        `<text x="${shape.x}" y="${shape.y}" fill="${escapeXml(shape.color)}" ` +
        `font-family="system-ui, sans-serif" font-size="${fontSize}" font-weight="700" ` +
        // A contrasting halo keeps red text legible on a red-ish photo.
        `stroke="#ffffff" stroke-width="${Math.max(1, stroke / 2)}" paint-order="stroke">${escapeXml(shape.text)}</text>`
      );
  }
}

/** Inner SVG content (no root element) — for the on-screen overlay. */
export function shapesToSvgContent(shapes: Shape[], natural: Size): string {
  const stroke = strokeWidthFor(natural);
  const fontSize = fontSizeFor(natural);
  return shapes.map((shape) => shapeMarkup(shape, stroke, fontSize)).join('');
}

/** A standalone SVG document sized to the image. */
export function shapesToSvgDocument(shapes: Shape[], natural: Size): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${natural.width}" height="${natural.height}" ` +
    `viewBox="0 0 ${natural.width} ${natural.height}">${shapesToSvgContent(shapes, natural)}</svg>`
  );
}

/**
 * Flatten image + annotations into one PNG.
 *
 * A flat raster, not a layered format, because the consumer is an image model:
 * it needs to *see* the red circle next to the thing being pointed at. The
 * vector shapes are deliberately not persisted (spec D5) — re-editing a past
 * annotation is not the workflow.
 */
export async function composeAnnotatedPng(imageSrc: string, shapes: Shape[], natural: Size): Promise<Blob> {
  const base = await loadImage(imageSrc);
  const canvas = document.createElement('canvas');
  canvas.width = natural.width;
  canvas.height = natural.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(base, 0, 0, natural.width, natural.height);

  if (shapes.length > 0) {
    const svgUrl = URL.createObjectURL(
      new Blob([shapesToSvgDocument(shapes, natural)], { type: 'image/svg+xml;charset=utf-8' }),
    );
    try {
      ctx.drawImage(await loadImage(svgUrl), 0, 0, natural.width, natural.height);
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas export failed'))), 'image/png');
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`could not load ${src}`));
    image.src = src;
  });
}
