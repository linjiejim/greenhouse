/**
 * `uploadUrl` (./upload.ts): an upload url resolved against the active station with `new URL`,
 * not string concatenation. Runs in the ROOT vitest unit project with `react-native`,
 * `expo-image-manipulator`, the station registry and the API client mocked (virtual — the
 * app's own install is absent in CI).
 */

import { describe, expect, it, vi } from 'vitest';

const state = { base: 'https://a.example' };

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-image-manipulator', () => ({ ImageManipulator: {}, SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('../store/stations', () => ({ getApiBase: () => state.base }));
vi.mock('./client', () => ({ api: vi.fn() }));

const { uploadUrl } = await import('./upload');

describe('uploadUrl', () => {
  it('puts a path on the active station', () => {
    expect(uploadUrl('/api/upload/img_1.png')).toBe('https://a.example/api/upload/img_1.png');
    state.base = 'http://10.0.0.5:3000';
    expect(uploadUrl('/api/upload/img_1.png')).toBe('http://10.0.0.5:3000/api/upload/img_1.png');
    state.base = 'https://a.example';
  });

  it('keeps an absolute URL', () => {
    expect(uploadUrl('https://cdn.example/x.png')).toBe('https://cdn.example/x.png');
  });

  it('never turns the station into userinfo', () => {
    // String joining made this https://a.example@evil.example/x.png — a request to evil.example.
    expect(uploadUrl('@evil.example/x.png')).toBe('https://a.example/@evil.example/x.png');
  });

  it('keeps the query string', () => {
    expect(uploadUrl('/api/upload/img_1.png?w=2')).toBe('https://a.example/api/upload/img_1.png?w=2');
  });
});
