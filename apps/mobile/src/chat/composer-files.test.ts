import { describe, expect, it } from 'vitest';
import { canSendMessage, filesReady, sentParts, uploadsAsImage, type ComposerFile } from './composer-files';

const file = (over: Partial<ComposerFile>): ComposerFile => ({ id: 'f', uri: 'u', name: 'a.pdf', kind: 'file', status: 'done', ...over });

describe('the composer’s files', () => {
  it('sends only once every file is uploaded', () => {
    const ready = file({ remote: { kind: 'file', file: { id: 'cf', name: 'a.pdf' } } });
    expect(filesReady([ready])).toBe(true);
    expect(filesReady([ready, file({ status: 'uploading' })])).toBe(false);
    expect(canSendMessage('', [ready])).toBe(true);
    expect(canSendMessage('  ', [])).toBe(false);
    expect(canSendMessage('hi', [file({ status: 'error' })])).toBe(false);
  });

  it('splits pictures from attached files', () => {
    const parts = sentParts([
      file({ remote: { kind: 'image', image: { id: '1.jpg', url: '/api/upload/1.jpg' } } }),
      file({ remote: { kind: 'file', file: { id: 'cf', name: 'a.pdf', size: 3 } } }),
    ]);
    expect(parts).toEqual({ images: [{ id: '1.jpg', url: '/api/upload/1.jpg' }], attachments: [{ id: 'cf', name: 'a.pdf', size: 3 }] });
  });

  it('knows which files go up as pictures', () => {
    expect(uploadsAsImage('image/heic', 'IMG_1.HEIC')).toBe(true);
    expect(uploadsAsImage(undefined, 'shot.PNG')).toBe(true);
    expect(uploadsAsImage('image/svg+xml', 'x.svg')).toBe(false);
    expect(uploadsAsImage('application/pdf', 'a.pdf')).toBe(false);
  });
});
