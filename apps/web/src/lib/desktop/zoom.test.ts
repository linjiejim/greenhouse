import { describe, expect, it } from 'vitest';

import { DEFAULT_ZOOM, ZOOM_STEPS, applyZoomCommand, matchZoomKey, readStoredZoom, stepZoom } from './zoom';

const key = (over: Partial<KeyboardEvent>) => ({ key: '', metaKey: false, ctrlKey: false, altKey: false, ...over });

describe('stepZoom', () => {
  it('moves one stop along the ladder', () => {
    expect(stepZoom(1, 'in')).toBe(1.1);
    expect(stepZoom(1, 'out')).toBe(0.9);
    expect(stepZoom(1.75, 'in')).toBe(2);
  });

  it('clamps at both ends instead of running off the ladder', () => {
    expect(stepZoom(ZOOM_STEPS[0], 'out')).toBe(ZOOM_STEPS[0]);
    expect(stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1], 'in')).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  });

  it('snaps an off-ladder level onto the nearest stop before moving', () => {
    expect(stepZoom(1.04, 'in')).toBe(1.1);
    expect(stepZoom(1.04, 'out')).toBe(0.9);
  });
});

describe('applyZoomCommand', () => {
  it('resets to 100% from anywhere', () => {
    expect(applyZoomCommand(2, 'reset')).toBe(DEFAULT_ZOOM);
    expect(applyZoomCommand(0.5, 'reset')).toBe(DEFAULT_ZOOM);
  });
});

describe('readStoredZoom', () => {
  it('restores a level that was actually stored', () => {
    expect(readStoredZoom('1.25')).toBe(1.25);
  });

  it('falls back to 100% for missing or unparseable values', () => {
    expect(readStoredZoom(null)).toBe(DEFAULT_ZOOM);
    expect(readStoredZoom('')).toBe(DEFAULT_ZOOM);
    expect(readStoredZoom('huge')).toBe(DEFAULT_ZOOM);
  });

  it('falls back rather than clamping an off-scale value', () => {
    // Clamping a corrupt 0.01 to 50% would leave the window at a size the user
    // never chose, with no reason to think zoom was involved.
    expect(readStoredZoom('0.01')).toBe(DEFAULT_ZOOM);
    expect(readStoredZoom('40')).toBe(DEFAULT_ZOOM);
  });

  it('snaps a near-miss onto the ladder', () => {
    expect(readStoredZoom('1.26')).toBe(1.25);
  });
});

describe('matchZoomKey', () => {
  it('accepts the macOS and Windows accelerators', () => {
    expect(matchZoomKey(key({ key: '=', metaKey: true }))).toBe('in');
    expect(matchZoomKey(key({ key: '-', ctrlKey: true }))).toBe('out');
    expect(matchZoomKey(key({ key: '0', metaKey: true }))).toBe('reset');
  });

  it('accepts the shifted variants the native menu cannot claim', () => {
    expect(matchZoomKey(key({ key: '+', metaKey: true }))).toBe('in');
    expect(matchZoomKey(key({ key: '_', metaKey: true }))).toBe('out');
  });

  it('ignores the same keys without the command modifier', () => {
    expect(matchZoomKey(key({ key: '-' }))).toBeNull();
    expect(matchZoomKey(key({ key: '0' }))).toBeNull();
  });

  it('ignores combinations that add alt, which belong to other commands', () => {
    expect(matchZoomKey(key({ key: '0', metaKey: true, altKey: true }))).toBeNull();
  });

  it('ignores unrelated keys', () => {
    expect(matchZoomKey(key({ key: 'k', metaKey: true }))).toBeNull();
  });
});
