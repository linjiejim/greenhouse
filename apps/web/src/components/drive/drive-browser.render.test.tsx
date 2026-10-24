import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { filesPageHref, parseFilesLocation } from '@greenhouse/types/files';
import { I18nProvider } from '../../lib/i18n';
import type { DriveFile, DriveFolder } from '../../lib/api/drive';
import { drivePreviewKind, MAX_TEXT_PREVIEW_BYTES } from './drive-file-preview';
import { folderTreeRows } from './drive-dialogs';
import { deepLinkPreview } from './drive-browser';

vi.mock('../../lib/api/drive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/drive')>();
  return { ...actual, listDriveFolders: vi.fn(async () => []), listDriveFiles: vi.fn(async () => []) };
});

function folder(id: number, parent_id: number | null, name = `f${id}`): DriveFolder {
  return {
    id: String(id),
    parent_id: parent_id == null ? null : String(parent_id),
    name,
    scope: 'kb',
    visibility: 'team',
    owner_user_id: null,
    base_id: null,
    sort_order: 0,
    created_by: null,
    created_at: '',
    updated_at: '',
  };
}

describe('drive preview kinds', () => {
  it('previews images, PDFs and small text documents, and downloads everything else', () => {
    expect(drivePreviewKind({ name: 'photo.JPG', size: 10 })).toBe('image');
    expect(drivePreviewKind({ name: 'report.pdf', size: 10 })).toBe('pdf');
    expect(drivePreviewKind({ name: 'notes.md', size: 10 })).toBe('text');
    expect(drivePreviewKind({ name: 'huge.log', size: MAX_TEXT_PREVIEW_BYTES + 1 })).toBeNull();
    // Active content never previews, whatever it claims to be.
    expect(drivePreviewKind({ name: 'page.html', size: 10 })).toBeNull();
    expect(drivePreviewKind({ name: 'logo.svg', size: 10 })).toBeNull();
    expect(drivePreviewKind({ name: 'archive.zip', size: 10 })).toBeNull();
  });
});

describe('move targets', () => {
  it('lists the tree depth-first and leaves out the moving folder and its subtree', () => {
    const rows = folderTreeRows([folder(1, null), folder(2, 1), folder(3, 2), folder(4, null)], '2');
    expect(rows.map((row) => [row.folder.id, row.depth])).toEqual([
      ['1', 0],
      ['4', 0],
    ]);
    expect(folderTreeRows([folder(1, null), folder(2, 1)], null).map((row) => row.depth)).toEqual([0, 1]);
  });
});

describe('Files page addresses', () => {
  it('round-trips shelf, folder and file through the hash', () => {
    const href = filesPageHref({ shelf: 'personal', folderId: '7', fileId: '9' });
    expect(href).toBe('#/files?shelf=personal&folder=7&file=9');
    expect(parseFilesLocation(new URLSearchParams(href.split('?')[1]))).toEqual({
      shelf: 'personal',
      folderId: '7',
      fileId: '9',
    });
    expect(filesPageHref({ shelf: 'team' })).toBe('#/files');
    expect(parseFilesLocation(new URLSearchParams('folder=a%20b&file=-1'))).toEqual({
      shelf: 'team',
      folderId: null,
      fileId: null,
    });
  });
});

describe('deep-linked preview', () => {
  const file = { id: '9', name: 'notes.md', size: 10 } as DriveFile;
  it('opens once per visit and again after the link clears and returns', () => {
    const first = deepLinkPreview(null, '9', [file]);
    expect(first.open?.id).toBe('9');
    expect(deepLinkPreview(first.handled, '9', [file]).open).toBeNull();
    const cleared = deepLinkPreview(first.handled, null, [file]);
    expect(cleared.handled).toBeNull();
    // Back to the same deep link reopens the preview.
    expect(deepLinkPreview(cleared.handled, '9', [file]).open?.id).toBe('9');
  });

  it('waits for the file to be listed and never previews what it cannot', () => {
    expect(deepLinkPreview(null, '9', [])).toEqual({ handled: null, open: null });
    expect(deepLinkPreview(null, '9', [{ ...file, name: 'a.zip' }]).open).toBeNull();
  });
});

describe('Files search hits', () => {
  it('labels and opens a personal hit on the personal shelf', async () => {
    const { FilesSearchList } = await import('../../pages/files');
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(FilesSearchList, {
          result: {
            folders: [],
            files: [
              {
                id: '3',
                name: 'mine.txt',
                shelf: 'personal',
                folder_id: '5',
                size: 1,
                content_type: null,
                uploaded_by: 'u1',
                created_at: '2026-10-01T00:00:00.000Z',
                updated_at: '2026-10-01T00:00:00.000Z',
                url: filesPageHref({ shelf: 'personal', folderId: '5', fileId: '3' }),
              },
            ],
          },
          onOpen: () => {},
        }),
      }),
    );
    expect(html).toContain('My files');
    expect(html).not.toContain('Team files');
    expect(html).toContain('data-href="#/files?shelf=personal&amp;folder=5&amp;file=3"');
  });
});

describe('DriveBrowser', () => {
  it('renders the cabinet controls in both languages', async () => {
    const { DriveBrowser } = await import('./drive-browser');
    for (const [locale, upload] of [
      ['en', 'Upload'],
      ['zh', '上传'],
    ] as const) {
      const html = renderToStaticMarkup(
        createElement(I18nProvider, {
          initialLocale: locale,
          children: createElement(DriveBrowser, {
            owner: { scope: 'kb', visibility: 'team' },
            folderId: null,
            onFolderChange: () => {},
          }),
        }),
      );
      expect(html).toContain(upload);
    }
  });
});
