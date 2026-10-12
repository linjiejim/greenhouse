import { describe, expect, it } from 'vitest';
import { canSendMessage, recoverDraftImages, type ComposerImage } from './composer-images';

const ready: ComposerImage = {
  id: 'a',
  uri: 'file:///a.jpg',
  status: 'done',
  remote: { id: 'remote-a', url: '/a.jpg' },
};
const failed: ComposerImage = { id: 'b', uri: 'file:///b.heic', width: 2000, mimeType: 'image/heic', status: 'error' };

describe('sending a draft with selected images', () => {
  it('allows text or uploaded images, but not an empty draft', () => {
    expect(canSendMessage(' \n ', [])).toBe(false);
    expect(canSendMessage('Compare these', [])).toBe(true);
    expect(canSendMessage('', [ready])).toBe(true);
  });

  it('never silently sends only the successful part of a selection', () => {
    expect(canSendMessage('Compare these', [ready, failed])).toBe(false);
    expect(canSendMessage('Compare these', [ready, { ...failed, status: 'uploading' }])).toBe(false);
    expect(canSendMessage('Compare these', [{ ...failed, status: 'done' }])).toBe(false);
    const retried: ComposerImage = { ...failed, status: 'done', remote: { id: 'remote-b', url: '/b.jpg' } };
    expect(canSendMessage('Compare these', [ready, retried])).toBe(true);
    expect(canSendMessage('Compare these', [ready])).toBe(true); // explicitly removed the failed image
  });

  it('keeps interrupted and failed attachments in a thread draft for retry, in their original order', () => {
    const uploading: ComposerImage = { ...failed, id: 'c', status: 'uploading' };
    const recovered = recoverDraftImages([ready, failed, uploading]);
    expect(recovered).toEqual([ready, failed, { ...uploading, status: 'error' }]);
    expect(uploading.status).toBe('uploading');
    expect(canSendMessage('Keep all three', recovered)).toBe(false);
  });
});
