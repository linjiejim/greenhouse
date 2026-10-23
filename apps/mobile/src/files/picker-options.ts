/**
 * What the photo library and the camera are opened with for a Files upload. React-free
 * (./picker-options.test.ts). The camera takes photos only: recording video needs the microphone
 * permission, which the app does not ask for (app.json `microphonePermission: false`), and asking
 * the camera for videos then fails before it opens.
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
