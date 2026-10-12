import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { base: 'https://a.example' };

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-image-manipulator', () => ({ ImageManipulator: {}, SaveFormat: {} }));
vi.mock('expo-file-system', () => ({
  File: class extends Blob {
    name = 'photo.png';
    constructor(readonly uri: string) {
      super(['native-image-bytes'], { type: 'image/png' });
    }
  },
}));
vi.mock('../store/stations', () => ({ getApiBase: () => state.base }));
vi.mock('./client', () => ({ api: vi.fn() }));

import { api } from './client';
import { uploadImage, uploadUrl } from './upload';

const uploaded = { id: 'image-1', url: '/public/photo.png' };
beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe('native image upload', () => {
  it('sends serializable image bytes, not a React Native URI descriptor', async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      expect(path).toBe('/api/upload');
      expect(init?.method).toBe('POST');
      const file = (init?.body as FormData).get('file') as File;
      expect(file).toBeInstanceOf(Blob);
      expect(file.type).toBe('image/png');
      expect(await file.text()).toBe('native-image-bytes');
      // Exercise multipart serialization: a plain { uri, type, name } becomes "[object Object]".
      const request = new Request('http://localhost/api/upload', init);
      expect(await request.text()).toContain('native-image-bytes');
      return Response.json(uploaded);
    });
    expect(await uploadImage('file:///photo.png', 'image/png')).toEqual(uploaded);
  });

  it('reports a rejected or interrupted upload as a failure', async () => {
    vi.mocked(api).mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(await uploadImage('file:///photo.png')).toBeNull();
    vi.mocked(api).mockRejectedValueOnce(new TypeError('Network request failed'));
    expect(await uploadImage('file:///photo.png')).toBeNull();
  });
});

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
