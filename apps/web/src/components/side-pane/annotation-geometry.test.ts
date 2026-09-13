import { describe, expect, it } from 'vitest';
import { isDegenerateDrag, shapeFromDrag, strokeWidthFor, toImagePoint, type Size } from './annotation-geometry';
import { shapesToSvgDocument } from './annotation-render';

const natural: Size = { width: 1000, height: 500 };

/** A rendered box the way `object-contain` would lay this image out. */
function rect(width: number, height: number, left = 0, top = 0): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top } as DOMRect;
}

describe('toImagePoint', () => {
  it('maps a click to image pixels when the box matches the aspect ratio', () => {
    // Box is exactly half scale, so the centre of the box is the centre of the image.
    expect(toImagePoint(250, 125, rect(500, 250), natural)).toEqual({ x: 500, y: 250 });
  });

  it('accounts for object-contain letterboxing rather than the element size', () => {
    // A 500x500 box around a 2:1 image leaves 125px bands top and bottom.
    // Scaling by the ELEMENT height would place this click at y=250; the
    // fitted size puts it at the image's vertical centre.
    expect(toImagePoint(250, 250, rect(500, 500), natural)).toEqual({ x: 500, y: 250 });
    // The top edge of the picture, not of the element.
    expect(toImagePoint(0, 125, rect(500, 500), natural)).toEqual({ x: 0, y: 0 });
  });

  it('clamps a drag that leaves the picture', () => {
    expect(toImagePoint(-999, -999, rect(500, 250), natural)).toEqual({ x: 0, y: 0 });
    expect(toImagePoint(9999, 9999, rect(500, 250), natural)).toEqual({ x: 1000, y: 500 });
  });

  it('respects the element offset within the viewport', () => {
    expect(toImagePoint(340, 220, rect(500, 250, 90, 95), natural)).toEqual({ x: 500, y: 250 });
  });
});

describe('shapeFromDrag', () => {
  it('builds an ellipse from the drag bounding box regardless of direction', () => {
    const forward = shapeFromDrag('ellipse', 1, '#f00', { x: 100, y: 100 }, { x: 300, y: 200 });
    const backward = shapeFromDrag('ellipse', 1, '#f00', { x: 300, y: 200 }, { x: 100, y: 100 });
    expect(forward).toEqual(backward);
    expect(forward).toMatchObject({ cx: 200, cy: 150, rx: 100, ry: 50 });
  });

  it('normalizes a rect dragged up-left', () => {
    expect(shapeFromDrag('rect', 2, '#f00', { x: 300, y: 200 }, { x: 100, y: 100 })).toMatchObject({
      x: 100,
      y: 100,
      width: 200,
      height: 100,
    });
  });

  it('keeps arrow direction, because the head has to land on the target', () => {
    expect(shapeFromDrag('arrow', 3, '#f00', { x: 10, y: 20 }, { x: 90, y: 80 })).toMatchObject({
      x1: 10,
      y1: 20,
      x2: 90,
      y2: 80,
    });
  });
});

describe('strokeWidthFor', () => {
  it('scales with the image so marks read at any resolution', () => {
    // 2px is bold on a thumbnail and invisible on a scan; the export is always
    // at full resolution.
    expect(strokeWidthFor({ width: 400, height: 300 })).toBe(2);
    expect(strokeWidthFor({ width: 4000, height: 3000 })).toBe(16);
  });
});

describe('isDegenerateDrag', () => {
  it('rejects a stray click that would leave an invisible zero-size mark', () => {
    expect(isDegenerateDrag({ x: 100, y: 100 }, { x: 102, y: 101 }, natural)).toBe(true);
    expect(isDegenerateDrag({ x: 100, y: 100 }, { x: 200, y: 180 }, natural)).toBe(false);
  });
});

describe('shapesToSvgDocument', () => {
  it('escapes text so a caption cannot inject markup', () => {
    const svg = shapesToSvgDocument(
      [{ id: 1, kind: 'text', color: '#f00', x: 10, y: 20, text: '<script>alert(1)</script>' }],
      natural,
    );
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('draws the arrow head as path segments, not a <marker> reference', () => {
    // Marker ids resolve through <defs>, which does not survive rasterizing the
    // SVG through an <img> in every browser.
    const svg = shapesToSvgDocument([{ id: 1, kind: 'arrow', color: '#f00', x1: 0, y1: 0, x2: 100, y2: 0 }], natural);
    expect(svg).not.toContain('marker');
    expect(svg.match(/<path /g)).toHaveLength(2);
  });

  it('sizes the document in image pixels so the export lines up', () => {
    const svg = shapesToSvgDocument([], natural);
    expect(svg).toContain('width="1000"');
    expect(svg).toContain('viewBox="0 0 1000 500"');
  });
});
