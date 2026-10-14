import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  MAX_EXPORT_DOCS,
  notesEntry,
  planExport,
  relativePath,
  safeSegment,
  zipStream,
  type ExportInput,
  type ExportPlan,
} from '../export.js';
import { fileLinks } from '../markdown.js';

const DOC_A = 'doc_01JAAAAAAAAAAAAAAAAAAAAAAA';
const DOC_B = 'doc_01JBBBBBBBBBBBBBBBBBBBBBBB';
const DOC_C = 'doc_01JCCCCCCCCCCCCCCCCCCCCCCC';
const PIC = 'fil_01JDDDDDDDDDDDDDDDDDDDDDDD';
const PDF = 'fil_01JEEEEEEEEEEEEEEEEEEEEEEE';
const GONE = 'fil_01JFFFFFFFFFFFFFFFFFFFFFFF';

function input(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    rootId: 'fld_root',
    folders: [
      { id: 'fld_root', parentId: null, name: 'Handbook' },
      { id: 'fld_hr', parentId: 'fld_root', name: '人事 / HR' },
      { id: 'fld_deep', parentId: 'fld_hr', name: 'Leave' },
    ],
    docs: [
      { id: DOC_A, folderId: 'fld_root', title: 'Welcome', version: 3, updatedAt: '2026-10-14T00:00:00Z' },
      { id: DOC_B, folderId: 'fld_deep', title: 'Leave policy', version: 1, updatedAt: '2026-10-14T00:00:00Z' },
      { id: 'doc_dup', folderId: 'fld_deep', title: 'Leave policy', version: 1, updatedAt: 'x' },
    ],
    files: [{ id: PDF, folderId: 'fld_hr', name: 'form.pdf', sizeBytes: 10 }],
    assets: [{ id: PIC, folderId: null, name: 'chart.png', sizeBytes: 5 }],
    locale: 'en',
    label: 'Handbook',
    exportedAt: '2026-10-14T08:00:00.000Z',
    links: fileLinks('https://greenhouse.example'),
    ...overrides,
  };
}

/** The docs' Markdown, read only when they are written. */
const CONTENTS: Record<string, string> = {
  [DOC_A]: `Start with [Leave](#/knowledge/${DOC_B}) and [elsewhere](#/knowledge/${DOC_C}).\n\n![chart](/api/files/${PIC}/content)\n`,
  [DOC_B]: `Back to [Welcome](#/knowledge/${DOC_A}); the form is [here](/api/files/${PDF}/content); missing ![x](/api/files/${GONE}/content)`,
};

/** Every path the archive gets, and the text of each doc, as the writer produces them. */
function written(plan: ExportPlan) {
  const texts = new Map(plan.docs.map(({ doc, path }) => [path, plan.render(doc, path, CONTENTS[doc.id] ?? '')]));
  return {
    paths: [...plan.entries.map((entry) => entry.path), ...texts.keys()],
    text: (path: string) => texts.get(path)!,
  };
}

describe('the export layout', () => {
  it('mirrors the tree under the exported folder, with safe and unique names', () => {
    expect(written(planExport(input())).paths).toEqual([
      'README.md',
      '人事 - HR/form.pdf',
      'assets/chart.png',
      'Welcome.md',
      '人事 - HR/Leave/Leave policy.md',
      '人事 - HR/Leave/Leave policy (2).md',
    ]);
  });

  it('rewrites links to exported docs and files as relative paths, and keeps the rest', () => {
    const plan = planExport(input());
    const { text } = written(plan);
    const { notes } = plan;
    const welcome = text('Welcome.md');
    expect(welcome).toMatch(/^---\ntitle: "Welcome"\nid: doc_01JA+\nversion: 3\n/);
    expect(welcome).toContain('[Leave](<人事 - HR/Leave/Leave policy.md>)');
    expect(welcome).toContain(`[elsewhere](#/knowledge/${DOC_C})`);
    expect(welcome).toContain('![chart](assets/chart.png)');
    const leave = text('人事 - HR/Leave/Leave policy.md');
    expect(leave).toContain('[Welcome](../../Welcome.md)');
    expect(leave).toContain('[here](../form.pdf)');
    expect(leave).toContain(`![x](/api/files/${GONE}/content)`);
    expect(notes).toEqual(['"Leave policy" shows a file you cannot open; its link was kept.']);
  });

  it('packs a whole space from its root and lists what was too big', () => {
    const plan = planExport(
      input({
        rootId: null,
        files: [{ id: PDF, folderId: null, name: 'huge.bin', sizeBytes: 2 * 1024 ** 3 }],
        assets: [],
        locale: 'zh',
      }),
    );
    const { paths } = written(plan);
    const { notes } = plan;
    expect(paths).toContain('Handbook/Welcome.md');
    expect(paths.some((path) => path.endsWith('huge.bin'))).toBe(false);
    expect(notes).toContain('文件总量超过上限，没有打包：huge.bin');
    expect(notesEntry('zh', notes)?.path).toBe('EXPORT-NOTES.md');
    expect(notesEntry('zh', [])).toBeNull();
  });

  it('plans names and paths only, and says what the caps left out', () => {
    const many = Array.from({ length: MAX_EXPORT_DOCS + 1 }, (_, index) => ({
      id: `doc_${String(index).padStart(26, '0')}`,
      folderId: null,
      title: `Doc ${index}`,
      version: 1,
      updatedAt: 'x',
    }));
    const plan = planExport(input({ docs: many, more: { folders: true, files: true, assets: true } }));
    expect(plan.docs).toHaveLength(MAX_EXPORT_DOCS);
    expect(plan.entries.every((entry) => !('text' in entry) || entry.path === 'README.md')).toBe(true);
    expect(plan.notes).toEqual([
      'More than 5000 folders: the rest, and what is in them, were left out.',
      'More than 5000 files: the rest were not packed.',
      'The docs show more than 5000 files: the rest kept their links.',
      'More than 5000 docs: the rest were left out.',
    ]);
  });

  it('makes names every system accepts and paths between directories', () => {
    expect(safeSegment('a/b\\c:d*e?"f<g>h|i', 'x')).toBe('a-b-c-d-e--f-g-h-i');
    expect(safeSegment(' ..  ', 'fallback')).toBe('fallback');
    expect(safeSegment('ends with dots...', 'x')).toBe('ends with dots');
    expect(relativePath('a/b', 'a/c/d.md')).toBe('../c/d.md');
    expect(relativePath('', 'x y.md')).toBe('<x y.md>');
  });
});

describe('zipStream', () => {
  it('writes entries while they are read, a file in many chunks', async () => {
    const big = new Uint8Array(512 * 1024).map((_, index) => index % 251);
    const body = zipStream(async (zip) => {
      await zip.text('README.md', '# 你好\n');
      await zip.stream(
        'data/big.bin',
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < big.length; offset += 64 * 1024) {
              controller.enqueue(big.subarray(offset, offset + 64 * 1024));
            }
            controller.close();
          },
        }),
      );
    });
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const unpacked = unzipSync(bytes);
    expect(strFromU8(unpacked['README.md']!)).toBe('# 你好\n');
    expect(Buffer.compare(Buffer.from(unpacked['data/big.bin']!), Buffer.from(big))).toBe(0);
  });

  it('fails the download when writing fails', async () => {
    const body = zipStream(async () => {
      throw new Error('storage went away');
    });
    await expect(new Response(body).arrayBuffer()).rejects.toThrow('storage went away');
  });
});
