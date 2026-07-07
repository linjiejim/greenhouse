/**
 * Tests for the Sprouty SVG builder — the avatar DSL rendering contract:
 * color presets, free palette (wins over preset), face styles, accessories.
 */

import { describe, it, expect } from 'vitest';
import { buildSproutyFaceSvg } from '../../packages/ui/src/components/sprouty/sprouty-face-svg';
import { COLOR_PRESETS } from '../../packages/ui/src/components/sprouty/sprouty-constants';

describe('buildSproutyFaceSvg', () => {
  it('renders the forest default with the base body hex', () => {
    const svg = buildSproutyFaceSvg('idle');
    expect(svg).toContain('#a4d65e');
    expect(svg).toContain('<svg');
  });

  it('remaps the body/leaf hexes for a color preset', () => {
    const svg = buildSproutyFaceSvg('idle', { color: 'ocean' });
    expect(svg).toContain(COLOR_PRESETS.ocean.body);
    expect(svg).toContain(COLOR_PRESETS.ocean.leaf);
    expect(svg).not.toContain('#a4d65e');
  });

  it('free palette wins over the preset and derives shades from two hexes', () => {
    const svg = buildSproutyFaceSvg('idle', { color: 'ocean', palette: { body: '#112233', leaf: '#445566' } });
    expect(svg).toContain('#112233');
    expect(svg).toContain('#445566');
    expect(svg).not.toContain(COLOR_PRESETS.ocean.body);
    expect(svg).not.toContain(COLOR_PRESETS.ocean.leaf);
  });

  it('ignores invalid palette hexes instead of emitting them', () => {
    const svg = buildSproutyFaceSvg('idle', { palette: { body: 'javascript:alert(1)', leaf: '#12' } });
    expect(svg).toContain('#a4d65e'); // untouched default
    expect(svg).not.toContain('javascript:');
  });

  it('face styles restyle the neutral eyes but not expression-specific ones', () => {
    const dflt = buildSproutyFaceSvg('idle', { animate: false });
    const happy = buildSproutyFaceSvg('idle', { animate: false, faceStyle: 'happy' });
    const sparkle = buildSproutyFaceSvg('idle', { animate: false, faceStyle: 'sparkle' });
    const sleepy = buildSproutyFaceSvg('idle', { animate: false, faceStyle: 'sleepy' });
    expect(happy).not.toBe(dflt);
    expect(sparkle).not.toBe(dflt);
    expect(sleepy).not.toBe(dflt);
    // 'done' uses happy eyes regardless of faceStyle — expression wins.
    expect(buildSproutyFaceSvg('done', { animate: false, faceStyle: 'sleepy' })).toBe(
      buildSproutyFaceSvg('done', { animate: false }),
    );
  });

  it('renders accessories on top of the themed body', () => {
    const svg = buildSproutyFaceSvg('idle', { accessories: ['crown', 'round-glasses'], color: 'blossom' });
    expect(svg).toContain('#f5c542'); // crown gold, outside the theme remap
  });
});
