import { describe, expect, it } from 'vitest';
import { drawerSwipes, persistentSidebar, sidebarWidth } from './layout-rule';

describe('sidebar', () => {
  it('stays on screen only on an iPad window at regular width', () => {
    expect(persistentSidebar({ isPad: false, width: 402 })).toBe(false);
    expect(persistentSidebar({ isPad: false, width: 874 })).toBe(false); // a phone turned sideways
    expect(persistentSidebar({ isPad: true, width: 744 })).toBe(true); // iPad mini, portrait
    expect(persistentSidebar({ isPad: true, width: 1376 })).toBe(true);
    expect(persistentSidebar({ isPad: true, width: 320 })).toBe(false); // Slide Over
    expect(persistentSidebar({ isPad: true, width: 507 })).toBe(false);
  });

  it('is a drawer most of a phone wide, or a column on an iPad', () => {
    expect(sidebarWidth({ width: 402, persistent: false })).toBe(320);
    expect(sidebarWidth({ width: 320, persistent: false })).toBe(262);
    expect(sidebarWidth({ width: 1032, persistent: true })).toBe(280);
    expect(sidebarWidth({ width: 1376, persistent: true })).toBe(340);
  });

  it('opens by edge swipe only where the swipe is not the back gesture', () => {
    expect(drawerSwipes(false, 0)).toBe(true);
    // a pushed page (search, a folder, a base): the swipe goes back
    expect(drawerSwipes(false, 1)).toBe(false);
    expect(drawerSwipes(true, 0)).toBe(false);
  });
});
