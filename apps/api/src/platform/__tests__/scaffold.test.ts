import { describe, expect, it } from 'vitest';
import { buildPlatformAppScaffold } from '../scaffold.js';

describe('Platform application scaffold', () => {
  it('produces a deterministic, fail-closed application boundary', () => {
    const first = buildPlatformAppScaffold({
      appId: 'assetRegistry',
      title: 'Asset Registry',
    });
    const second = buildPlatformAppScaffold({
      appId: 'assetRegistry',
      title: 'Asset Registry',
    });

    expect(first).toEqual(second);
    expect(first.files.map((file) => file.path)).toEqual([
      'manifest.ts',
      'registration.ts',
      'application.test.ts',
      'README.md',
    ]);
    expect(first.files[0]?.content).toContain("id: 'assetRegistry'");
    expect(first.files[0]?.content).toContain("capability: 'assetRegistry.main.read'");
    expect(first.files[1]?.content).toContain("code: 'INTERNAL_ERROR'");
    expect(first.files[3]?.content).toContain('record-scope SQL, record IDOR, field read/write/export');
  });

  it('rejects unsafe IDs and table names before writing files', () => {
    expect(() => buildPlatformAppScaffold({ appId: '../escape' })).toThrow(/stable lowerCamelCase/);
    expect(() => buildPlatformAppScaffold({ appId: 'AssetRegistry' })).toThrow(/stable lowerCamelCase/);
    expect(() => buildPlatformAppScaffold({ appId: `a${'B'.repeat(62)}` })).toThrow(/too long/);
  });

  it('escapes human titles in generated TypeScript', () => {
    const scaffold = buildPlatformAppScaffold({
      appId: 'safeApp',
      title: "Owner's\nApp */",
    });
    expect(scaffold.title).toBe("Owner's App */");
    expect(scaffold.files[0]?.content).toContain(`title: "Owner's App */"`);
    expect(scaffold.files[0]?.content).toContain(`* Owner's App * / Platform Manifest.`);
    expect(scaffold.files[1]?.content).toContain(`message: "Owner's App */ handler is not implemented"`);
  });
});
