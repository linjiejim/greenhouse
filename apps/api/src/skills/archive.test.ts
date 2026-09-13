import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';

import { buildSkillArchive, skillArchiveFilename } from './archive.js';

describe('Skill ZIP archive', () => {
  it('packs every text and binary file beneath one installable root directory', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const archive = unzipSync(
      buildSkillArchive('acme-example', [
        { path: 'SKILL.md', content: '# Example' },
        { path: 'references/guide.md', content: 'Guide' },
        { path: 'assets/logo.png', content: Buffer.from(png).toString('base64'), encoding: 'base64' },
      ]),
    );

    expect(Object.keys(archive).sort()).toEqual([
      'acme-example/SKILL.md',
      'acme-example/assets/logo.png',
      'acme-example/references/guide.md',
    ]);
    expect(strFromU8(archive['acme-example/SKILL.md']!)).toBe('# Example');
    expect(archive['acme-example/assets/logo.png']).toEqual(png);
    expect(skillArchiveFilename('acme-example', '1.2.3')).toBe('acme-example-1.2.3.zip');
  });
});
