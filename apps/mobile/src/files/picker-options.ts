/**
 * What the photo library and the camera are opened with for a Files upload. React-free
 * (./picker-options.test.ts). The camera takes photos only (uploads are photos and files), so the
 * app asks for no microphone: app.json sets expo-image-picker's `microphonePermission` to false.
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
