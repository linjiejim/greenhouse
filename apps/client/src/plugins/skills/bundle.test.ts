import { describe, expect, it } from 'vitest';
import {
  bundleFromFiles,
  headingOf,
  MAX_BUNDLE_BYTES,
  MAX_FILES,
  nextVersion,
  parseTags,
  readFrontmatter,
  type PickedFile,
} from './bundle';

const text = (path: string, content: string): PickedFile => ({ path, bytes: new TextEncoder().encode(content) });
const SKILL =
  '---\nname: weekly-report\ndescription: "Writes the weekly report"\nversion: 1.2.0\n---\n# Weekly report\n';

describe('skill bundle from picked files', () => {
  it('drops the picked folder, keeps text as text and binary as base64, sorted', () => {
    const result = bundleFromFiles([
      text('weekly-report/SKILL.md', SKILL),
      { path: 'weekly-report/assets/logo.png', bytes: new Uint8Array([137, 80, 78, 71]) },
      text('weekly-report/.DS_Store', 'x'),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => file.path)).toEqual(['SKILL.md', 'assets/logo.png']);
    expect(result.files[0]).toEqual({ path: 'SKILL.md', content: SKILL });
    expect(result.files[1]).toEqual({ path: 'assets/logo.png', content: 'iVBORw==', encoding: 'base64' });
  });

  it('says what is wrong before anything is sent', () => {
    expect(bundleFromFiles([])).toEqual({ ok: false, problem: { kind: 'empty' } });
    expect(bundleFromFiles([text('skill.zip', 'PK')])).toEqual({ ok: false, problem: { kind: 'zip' } });
    expect(bundleFromFiles([text('README.md', 'x')])).toEqual({ ok: false, problem: { kind: 'no-skill-md' } });
    expect(bundleFromFiles([text('SKILL.md', 'x'), text('my notes.md', 'x')])).toMatchObject({
      ok: false,
      problem: { kind: 'path' },
    });
    expect(bundleFromFiles([text('SKILL.md', 'x'), text('skill.md', 'y')])).toMatchObject({
      ok: false,
      problem: { kind: 'duplicate' },
    });
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => text(`f${i}.md`, 'x'));
    expect(bundleFromFiles(many)).toMatchObject({ ok: false, problem: { kind: 'too-many' } });
    const big = { path: 'SKILL.md', bytes: new Uint8Array(MAX_BUNDLE_BYTES + 1) };
    expect(bundleFromFiles([big])).toMatchObject({ ok: false, problem: { kind: 'too-big' } });
  });

  it('reads SKILL.md the way the station does', () => {
    expect(readFrontmatter(SKILL)).toEqual({
      name: 'weekly-report',
      description: 'Writes the weekly report',
      version: '1.2.0',
    });
    expect(headingOf(SKILL)).toBe('Weekly report');
    expect(readFrontmatter('# no frontmatter')).toEqual({});
  });

  it('suggests the next version and reads tags', () => {
    expect(nextVersion('1.2.9')).toBe('1.2.10');
    expect(nextVersion(undefined)).toBe('0.1.0');
    expect(nextVersion('latest')).toBe('0.1.0');
    expect(parseTags('report, weekly，report ,')).toEqual(['report', 'weekly']);
  });
});
