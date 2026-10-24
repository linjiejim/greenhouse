import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mediaPickerOptions } from './picker-options';

const appJson = JSON.parse(readFileSync(new URL('../../app.json', import.meta.url), 'utf8')) as {
  expo: { plugins: unknown[] };
};
const pickerPlugin = appJson.expo.plugins.find(
  (entry): entry is [string, { microphonePermission?: unknown }] => Array.isArray(entry) && entry[0] === 'expo-image-picker',
);

describe('opening the photo library or the camera for an upload', () => {
  it('lets the camera take photos only, and keeps the microphone description dictation needs', () => {
    // `false` here would delete NSMicrophoneUsageDescription, and iOS ends the app on the first hold-to-talk
    expect(typeof pickerPlugin?.[1].microphonePermission).toBe('string');
    expect(mediaPickerOptions('camera').mediaTypes).toEqual(['images']);
    expect(mediaPickerOptions('camera').allowsMultipleSelection).toBe(false);
  });

  it('offers photos and videos, several at a time, from the library', () => {
    expect(mediaPickerOptions('photos')).toEqual({ mediaTypes: ['images', 'videos'], quality: 1, allowsMultipleSelection: true });
  });
});
