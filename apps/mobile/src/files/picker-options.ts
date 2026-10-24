/**
 * What the photo library and the camera are opened with for a Files upload. React-free
 * (./picker-options.test.ts). The camera takes photos only (uploads are photos and files; the
 * microphone permission in app.json is there for hold-to-talk dictation, never for recording).
 */

export type MediaSource = 'photos' | 'camera';

export interface MediaPickerOptions {
  mediaTypes: ('images' | 'videos')[];
  quality: number;
  allowsMultipleSelection: boolean;
}

export function mediaPickerOptions(from: MediaSource): MediaPickerOptions {
  return from === 'camera'
    ? { mediaTypes: ['images'], quality: 1, allowsMultipleSelection: false }
    : { mediaTypes: ['images', 'videos'], quality: 1, allowsMultipleSelection: true };
}
