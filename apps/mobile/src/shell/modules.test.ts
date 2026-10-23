import { describe, expect, it } from 'vitest';
import { HUB_MODULES, moduleOf } from './modules';

describe('the hub’s places', () => {
  it('starts at home and lists every module once', () => {
    expect(HUB_MODULES[0]!.id).toBe('home');
    expect(new Set(HUB_MODULES.map((m) => m.id)).size).toBe(HUB_MODULES.length);
    expect(HUB_MODULES.map((m) => m.id)).toEqual(['home', 'knowledge', 'files', 'projects', 'tables']);
  });

  it('resolves module routes and nothing else', () => {
    expect(moduleOf('files')?.href).toBe('/module/files');
    expect(moduleOf('home')).toBeNull();
    expect(moduleOf('../settings')).toBeNull();
    expect(moduleOf(undefined)).toBeNull();
  });
});
