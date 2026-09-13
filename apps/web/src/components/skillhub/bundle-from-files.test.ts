/**
 * Upload bundle assembly tests — the normalization the dialog does before
 * anything reaches the server: strip a wrapping folder, drop archive-manager
 * junk, split text from binary, and surface limit violations up-front.
 */

import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  deriveDisplayName,
  entriesFromZip,
  filesToSkillBundle,
  readFrontmatter,
  stripCommonRoot,
  MAX_BUNDLE_BYTES,
  MAX_FILES,
  type RawEntry,
} from './bundle-from-files';

const SKILL_MD = '---\nname: my-skill\ndescription: Does a thing\nversion: 0.2.0\n---\n\n# My Skill\n\nBody.\n';

const entry = (path: string, text: string): RawEntry => ({ path, bytes: strToU8(text) });

describe('filesToSkillBundle', () => {
  it('accepts a bare SKILL.md as the whole bundle', () => {
    const result = filesToSkillBundle([entry('SKILL.md', SKILL_MD)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: 'SKILL.md' });
    expect(result.files[0]!.encoding).toBeUndefined();
  });

  it('strips a single shared top-level directory', () => {
    const result = filesToSkillBundle([
      entry('my-skill/SKILL.md', SKILL_MD),
      entry('my-skill/references/notes.md', 'notes'),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/notes.md']);
  });

  it('keeps paths when entries do not share one root', () => {
    const result = filesToSkillBundle([entry('SKILL.md', SKILL_MD), entry('refs/a.md', 'a')]);
    expect(result.ok && result.files.map((f) => f.path)).toEqual(['SKILL.md', 'refs/a.md']);
  });

  it('drops __MACOSX, .DS_Store and ._ resource forks before deciding the root', () => {
    const result = filesToSkillBundle([
      entry('my-skill/SKILL.md', SKILL_MD),
      entry('__MACOSX/my-skill/._SKILL.md', 'junk'),
      entry('my-skill/.DS_Store', 'junk'),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((f) => f.path)).toEqual(['SKILL.md']);
  });

  it('base64-encodes non-text files and leaves text alone', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = filesToSkillBundle([entry('SKILL.md', SKILL_MD), { path: 'assets/logo.png', bytes: png }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const asset = result.files.find((f) => f.path === 'assets/logo.png')!;
    expect(asset.encoding).toBe('base64');
    expect(Uint8Array.from(atob(asset.content), (c) => c.charCodeAt(0))).toEqual(png);
  });

  it('sorts files by path (canonical order)', () => {
    const result = filesToSkillBundle([entry('z.md', 'z'), entry('SKILL.md', SKILL_MD), entry('a.md', 'a')]);
    expect(result.ok && result.files.map((f) => f.path)).toEqual(['SKILL.md', 'a.md', 'z.md']);
  });

  // ── Pre-flight limit checks (the server re-validates all of these) ──

  it('rejects a bundle without SKILL.md at the root', () => {
    const result = filesToSkillBundle([entry('README.md', 'readme'), entry('refs/a.md', 'a')]);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/SKILL\.md/);
  });

  it('still finds SKILL.md when the drop is a single wrapped folder', () => {
    // Dropping a `docs/` folder whose only file is SKILL.md is the folder case,
    // not a missing-SKILL.md case — the shared root is stripped.
    const result = filesToSkillBundle([entry('docs/SKILL.md', SKILL_MD)]);
    expect(result.ok && result.files.map((f) => f.path)).toEqual(['SKILL.md']);
  });

  it('rejects a nested SKILL.md that is not at the bundle root', () => {
    const result = filesToSkillBundle([entry('README.md', 'readme'), entry('docs/SKILL.md', SKILL_MD)]);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/SKILL\.md/);
  });

  it('rejects an empty selection', () => {
    expect(filesToSkillBundle([])).toMatchObject({ ok: false });
  });

  it('rejects too many files', () => {
    const many = [entry('SKILL.md', SKILL_MD)];
    for (let i = 0; i < MAX_FILES; i++) many.push(entry(`f${i}.md`, 'x'));
    const result = filesToSkillBundle(many);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/Too many files/);
  });

  it('rejects a bundle over the size cap', () => {
    const result = filesToSkillBundle([entry('SKILL.md', SKILL_MD), entry('big.md', 'x'.repeat(MAX_BUNDLE_BYTES))]);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/too large/i);
  });

  it('rejects illegal path segments and traversal', () => {
    expect(filesToSkillBundle([entry('SKILL.md', SKILL_MD), entry('bad name.md', 'x')])).toMatchObject({ ok: false });
    expect(filesToSkillBundle([entry('SKILL.md', SKILL_MD), entry('a/../../etc/passwd', 'x')])).toMatchObject({
      ok: false,
    });
    expect(filesToSkillBundle([entry('SKILL.md', SKILL_MD), entry('a\\b.md', 'x')])).toMatchObject({ ok: false });
  });

  it('rejects paths that collide case-insensitively', () => {
    const result = filesToSkillBundle([entry('SKILL.md', SKILL_MD), entry('README.md', 'a'), entry('readme.md', 'b')]);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/Duplicate/);
  });
});

describe('entriesFromZip', () => {
  it('expands a zip, skipping directory records and junk', () => {
    const zipped = zipSync({
      'my-skill/SKILL.md': strToU8(SKILL_MD),
      'my-skill/refs/a.md': strToU8('a'),
      '__MACOSX/my-skill/._SKILL.md': strToU8('junk'),
    });
    const entries = entriesFromZip(zipped);
    expect(entries.map((e) => e.path).sort()).toEqual(['my-skill/SKILL.md', 'my-skill/refs/a.md']);

    const bundle = filesToSkillBundle(entries);
    expect(bundle.ok && bundle.files.map((f) => f.path)).toEqual(['SKILL.md', 'refs/a.md']);
  });
});

describe('metadata helpers', () => {
  it('reads frontmatter and derives the display name', () => {
    expect(readFrontmatter(SKILL_MD)).toEqual({ name: 'my-skill', description: 'Does a thing', version: '0.2.0' });
    expect(deriveDisplayName(SKILL_MD)).toBe('My Skill');
    expect(readFrontmatter('# no frontmatter')).toEqual({});
  });
});

describe('stripCommonRoot', () => {
  it('returns the shared root only when every path has it', () => {
    expect(stripCommonRoot(['a/x.md', 'a/y.md'])).toBe('a/');
    expect(stripCommonRoot(['a/x.md', 'b/y.md'])).toBe('');
    expect(stripCommonRoot(['SKILL.md'])).toBe('');
    expect(stripCommonRoot([])).toBe('');
  });
});
