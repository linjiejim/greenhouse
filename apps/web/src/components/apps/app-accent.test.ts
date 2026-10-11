import { describe, expect, it } from 'vitest';
import { APP_ACCENTS, APP_ICONS } from '@greenhouse/types/apps';
import { APP_ICON_COMPONENTS, AppWindow, appIcon } from '../../lib/icons';
import { APP_ACCENT_CLASSES, appAccentClasses } from './app-accent';

describe('app catalog glyphs', () => {
  it('draws every icon name the spec allows, each with its own glyph', () => {
    expect(Object.keys(APP_ICON_COMPONENTS).sort()).toEqual([...APP_ICONS].sort());
    expect(new Set(Object.values(APP_ICON_COMPONENTS)).size).toBe(APP_ICONS.length);
  });

  it('falls back to the generic app glyph for a name it does not know', () => {
    expect(appIcon('cart')).toBe(APP_ICON_COMPONENTS.cart);
    expect(appIcon('rocket')).toBe(AppWindow);
    expect(appIcon(undefined)).toBe(AppWindow);
    expect(appIcon('constructor')).toBe(AppWindow);
  });
});

describe('app accents', () => {
  it('maps every accent to semantic token classes, never a raw colour', () => {
    expect(Object.keys(APP_ACCENT_CLASSES).sort()).toEqual([...APP_ACCENTS].sort());
    for (const classes of Object.values(APP_ACCENT_CLASSES)) {
      expect(classes).toMatch(/^bg-[a-z-]+ text-[a-z-]+$/);
      expect(classes).not.toMatch(/#|\[|rgb|white|black|-\d{2,3}\b/);
    }
  });

  it('keeps status colours out of app identity', () => {
    for (const classes of Object.values(APP_ACCENT_CLASSES)) {
      expect(classes).not.toMatch(/danger|warning|success|info|destructive/);
    }
  });

  it('draws an unknown accent as brand', () => {
    expect(appAccentClasses('teal')).toBe(APP_ACCENT_CLASSES.teal);
    expect(appAccentClasses('neon')).toBe(APP_ACCENT_CLASSES.brand);
    expect(appAccentClasses(null)).toBe(APP_ACCENT_CLASSES.brand);
  });
});
