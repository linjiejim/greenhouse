import { describe, it, expect } from 'vitest';
import {
  validateSkillName,
  validateBundleFiles,
  bundleContentHash,
  buildBundleJson,
  parseBundleJson,
  parseSkillMdFrontmatter,
  MAX_FILES,
  MAX_BUNDLE_BYTES,
} from './bundle.js';

const SKILL_MD = { path: 'SKILL.md', content: '---\nname: pdf-report\ndescription: Render PDFs\n---\n\n# PDF' };

describe('validateSkillName', () => {
  it('accepts kebab-case', () => {
    for (const ok of ['a', 'pdf-report', 'x1-y2-z3', 'a'.repeat(64)]) {
      expect(validateSkillName(ok), ok).toBeNull();
    }
  });
  it('rejects everything else', () => {
    for (const bad of ['', 'PDF', 'pdf_report', '-pdf', 'pdf-', 'pdf report', 'a'.repeat(65), '中文']) {
      expect(validateSkillName(bad), bad).toMatch(/Invalid skill name/);
    }
  });
});

describe('validateBundleFiles', () => {
  it('accepts a valid bundle and returns the canonical (sorted) form', () => {
    const result = validateBundleFiles([
      { path: 'scripts/render.py', content: 'print(1)' },
      SKILL_MD,
      { path: 'assets/logo.png', content: Buffer.from('png').toString('base64'), encoding: 'base64' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files.map((f) => f.path)).toEqual(['SKILL.md', 'assets/logo.png', 'scripts/render.py']);
    expect(result.value.fileCount).toBe(3);
    // decoded sizes: 'png' (3) + contents
    expect(result.value.sizeBytes).toBe(Buffer.byteLength(SKILL_MD.content) + 'print(1)'.length + 3);
    // utf8 files have no encoding field in canonical form
    expect(result.value.files[0]).not.toHaveProperty('encoding');
    expect(result.value.files[1]!.encoding).toBe('base64');
  });

  it('requires SKILL.md at the root', () => {
    const result = validateBundleFiles([{ path: 'docs/SKILL.md', content: 'x' }]);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/SKILL\.md at its root/) });
  });

  it('rejects traversal, absolute, backslash and exotic paths', () => {
    for (const bad of ['../evil.md', 'a/../b.md', '/etc/passwd', 'a\\b.md', 'a//b.md', './x.md', 'a b.md']) {
      const result = validateBundleFiles([SKILL_MD, { path: bad, content: 'x' }]);
      expect(result.ok, bad).toBe(false);
    }
  });

  it('rejects duplicates (case-insensitive — download targets may be case-insensitive filesystems)', () => {
    const result = validateBundleFiles([
      SKILL_MD,
      { path: 'README.md', content: 'a' },
      { path: 'readme.md', content: 'b' },
    ]);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/Duplicate path/) });
  });

  it('enforces file-count and total-size limits', () => {
    const tooMany = [SKILL_MD, ...Array.from({ length: MAX_FILES }, (_, i) => ({ path: `f${i}.md`, content: 'x' }))];
    expect(validateBundleFiles(tooMany).ok).toBe(false);

    const huge = [SKILL_MD, { path: 'big.txt', content: 'x'.repeat(MAX_BUNDLE_BYTES) }];
    expect(validateBundleFiles(huge)).toEqual({ ok: false, error: expect.stringMatching(/Bundle too large/) });
  });

  it('rejects invalid encodings and non-base64 content', () => {
    expect(validateBundleFiles([SKILL_MD, { path: 'a.bin', content: 'x', encoding: 'hex' as never }]).ok).toBe(false);
    expect(validateBundleFiles([SKILL_MD, { path: 'a.bin', content: '!!!not-base64!!!', encoding: 'base64' }]).ok).toBe(
      false,
    );
  });
});

describe('bundleContentHash / bundle JSON round-trip', () => {
  it('is order-independent via the canonical form and changes when content changes', () => {
    const a = validateBundleFiles([SKILL_MD, { path: 'b.md', content: 'b' }]);
    const b = validateBundleFiles([{ path: 'b.md', content: 'b' }, SKILL_MD]);
    if (!a.ok || !b.ok) throw new Error('expected valid');
    expect(bundleContentHash(a.value.files)).toBe(bundleContentHash(b.value.files));

    const c = validateBundleFiles([SKILL_MD, { path: 'b.md', content: 'CHANGED' }]);
    if (!c.ok) throw new Error('expected valid');
    expect(bundleContentHash(c.value.files)).not.toBe(bundleContentHash(a.value.files));
  });

  it('serializes and parses the stored payload', () => {
    const validated = validateBundleFiles([SKILL_MD]);
    if (!validated.ok) throw new Error('expected valid');
    const json = buildBundleJson('pdf-report', '1.0.0', validated.value.files);
    const parsed = parseBundleJson(json);
    expect(parsed).toMatchObject({ format: 1, name: 'pdf-report', version: '1.0.0' });
    expect(parsed!.files[0]!.path).toBe('SKILL.md');

    expect(parseBundleJson('not json')).toBeNull();
    expect(parseBundleJson('{"format":2}')).toBeNull();
  });
});

describe('parseSkillMdFrontmatter', () => {
  it('extracts name and description from the leading block', () => {
    expect(parseSkillMdFrontmatter(SKILL_MD.content)).toEqual({ name: 'pdf-report', description: 'Render PDFs' });
    expect(parseSkillMdFrontmatter('---\nname: "quoted"\n---\n')).toEqual({ name: 'quoted' });
  });

  it('returns {} when there is no frontmatter', () => {
    expect(parseSkillMdFrontmatter('# Just a title')).toEqual({});
  });
});
