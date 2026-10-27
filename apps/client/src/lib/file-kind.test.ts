import { describe, expect, it } from 'vitest';
import { extensionOf, fileKind } from './file-kind';

describe('file kinds', () => {
  it('reads the extension first', () => {
    expect(fileKind('投放明细.xlsx')).toBe('sheet');
    expect(fileKind('Report.PDF')).toBe('pdf');
    expect(fileKind('deck.key')).toBe('slides');
    expect(fileKind('notes.md')).toBe('text');
    expect(fileKind('photo.HEIC')).toBe('image');
    expect(fileKind('backup.tar.gz')).toBe('archive');
  });

  it('falls back to the content type, then other', () => {
    expect(fileKind('scan', 'application/pdf')).toBe('pdf');
    expect(fileKind('clip', 'video/quicktime')).toBe('video');
    expect(fileKind('export', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('sheet');
    expect(fileKind('blob')).toBe('other');
  });

  it('has no extension for dotfiles or a trailing dot', () => {
    expect(extensionOf('.env')).toBe('');
    expect(extensionOf('name.')).toBe('');
    expect(extensionOf('a.b.c')).toBe('c');
  });
});
