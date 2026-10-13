import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  checkPath,
  contentHash,
  PackageError,
  packageZip,
  parseFrontmatter,
  readPackage,
  readPackageZip,
} from '../package.js';

const SKILL_MD = `---
name: pdf-report
description: Turns notes into a PDF report.
version: 1.2.0
tags: [docs, pdf]
requirements:
  computer: true
  connectors: [github]
---
# PDF report

Write the report, then run scripts/build.py.
`;

const zip = (entries: Record<string, string | Uint8Array>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([path, value]) => [path, typeof value === 'string' ? strToU8(value) : value]),
    ),
  );

/** The message of the PackageError the call throws. */
function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PackageError);
    return (error as Error).message;
  }
  throw new Error('expected a PackageError');
}

describe('skill packages', () => {
  it('reads SKILL.md: name, description, version, tags, requirements and the body', () => {
    const read = readPackageZip(zip({ 'SKILL.md': SKILL_MD, 'scripts/build.py': 'print("hi")\n' }));
    expect(read).toMatchObject({
      name: 'pdf-report',
      description: 'Turns notes into a PDF report.',
      displayName: 'PDF report',
      version: '1.2.0',
      tags: ['docs', 'pdf'],
      requirements: { computer: true, connectors: ['github'] },
    });
    expect(read.body.startsWith('# PDF report')).toBe(true);
    expect(read.files.map((file) => file.path)).toEqual(['SKILL.md', 'scripts/build.py']);
    expect(read.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('drops one top folder and what archivers add', () => {
    const read = readPackageZip(
      zip({
        'pdf-report/SKILL.md': SKILL_MD,
        'pdf-report/ref/style.md': '# Style',
        '__MACOSX/pdf-report/._SKILL.md': 'junk',
        'pdf-report/.DS_Store': 'junk',
      }),
    );
    expect(read.files.map((file) => file.path)).toEqual(['SKILL.md', 'ref/style.md']);
  });

  it('refuses paths that leave the package or mean something else to a file system', () => {
    expect(failure(() => checkPath('../evil.sh'))).toContain('".."');
    expect(failure(() => checkPath('/etc/passwd'))).toContain('absolute');
    expect(failure(() => checkPath('C:/x.txt'))).toContain('absolute');
    expect(failure(() => checkPath('a\\b.txt'))).toContain('use / between folders');
    expect(failure(() => checkPath('a//b.txt'))).toContain('empty');
    expect(failure(() => checkPath('a/./b.txt'))).toContain('empty');
    expect(failure(() => checkPath('bad\u0001name'))).toContain('control');
    expect(failure(() => checkPath('what?.md'))).toContain('cannot have');
    expect(failure(() => checkPath(`${'a/'.repeat(120)}x`))).toContain('too long');
    expect(checkPath('参考/风格 指南.md')).toBe('参考/风格 指南.md');
    expect(failure(() => readPackageZip(zip({ 'SKILL.md': SKILL_MD, '../../etc/cron.d/x': 'x' })))).toContain('".."');
  });

  it('keeps to its limits before anything is inflated', () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`f${index}.txt`, 'x']));
    expect(failure(() => readPackageZip(zip({ 'SKILL.md': SKILL_MD, ...many })))).toContain('up to 100 files');
    // 11 MB of zeros packs into a few KB: the directory's sizes give it away.
    const bomb = zip({ 'SKILL.md': SKILL_MD, 'zeros.bin': new Uint8Array(11 * 1024 * 1024) });
    expect(bomb.byteLength).toBeLessThan(100_000);
    expect(failure(() => readPackageZip(bomb))).toContain('10 MB unpacked');
    expect(failure(() => readPackageZip(new Uint8Array(10 * 1024 * 1024 + 1)))).toContain('larger than 10 MB');
    expect(failure(() => readPackageZip(strToU8('not a zip at all')))).toContain('not a ZIP');
  });

  it('needs SKILL.md with a name and a description', () => {
    expect(failure(() => readPackageZip(zip({ 'README.md': '# hi' })))).toContain('SKILL.md');
    expect(failure(() => readPackageZip(zip({ 'SKILL.md': '# No frontmatter' })))).toContain('frontmatter');
    expect(failure(() => readPackageZip(zip({ 'SKILL.md': '---\nname: Bad Name\ndescription: x\n---\n' })))).toContain(
      'not valid',
    );
    expect(failure(() => readPackageZip(zip({ 'SKILL.md': '---\nname: ok\n---\nbody' })))).toContain('description');
    expect(
      failure(() => readPackageZip(zip({ 'SKILL.md': '---\nname: ok\ndescription: x\nversion: 1.0\n---\n' }))),
    ).toContain('1.2.0');
    expect(
      failure(() => readPackageZip(zip({ 'SKILL.md': '---\nname: ok\ndescription: x\nrequirements: lots\n---\n' }))),
    ).toContain('requirements');
    expect(failure(() => readPackageZip(zip({ 'SKILL.md': new Uint8Array([0xff, 0xfe, 0x00]) })))).toContain('UTF-8');
    expect(
      failure(() =>
        readPackage([
          { path: 'SKILL.md', bytes: strToU8(SKILL_MD) },
          { path: 'skill.md', bytes: strToU8('x') },
        ]),
      ),
    ).toContain('twice');
  });

  it('parses frontmatter as YAML without aliases', () => {
    expect(parseFrontmatter('---\nname: a\ndescription: "b: c"\n---\nbody\n')).toEqual({
      data: { name: 'a', description: 'b: c' },
      body: 'body\n',
    });
    expect(failure(() => parseFrontmatter('---\na: &x [1]\nb: *x\n---\n'))).toContain('YAML');
    expect(parseFrontmatter('\uFEFF---\nname: a\n---\n').data).toEqual({ name: 'a' });
  });

  it('stores a canonical ZIP: the same files always give the same bytes and hash', () => {
    const files = readPackageZip(zip({ 'scripts/build.py': 'print(1)', 'SKILL.md': SKILL_MD })).files;
    const first = packageZip('pdf-report', files);
    const again = packageZip('pdf-report', [...files].reverse());
    expect(Buffer.from(first).equals(Buffer.from(again))).toBe(true);
    expect(Object.keys(unzipSync(first))).toEqual(['pdf-report/SKILL.md', 'pdf-report/scripts/build.py']);
    const reread = readPackageZip(first);
    expect(reread.sha256).toBe(contentHash(files));
    expect(contentHash([...files].reverse())).toBe(contentHash(files));
    expect(contentHash([{ path: 'SKILL.md', bytes: strToU8(SKILL_MD.replace('notes', 'Notes')) }])).not.toBe(
      contentHash(files.filter((file) => file.path === 'SKILL.md')),
    );
  });
});
