import { describe, expect, it } from 'vitest';
import { openaiCompatibleImageAdapter } from '../image/adapters.js';
import { EndpointViolation } from '../pinned-fetch.js';
import { KEY, connect, json, sent } from './fake-network.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const gateway = { baseUrl: 'https://images.example.com/v1', model: 'flux-schnell', size: '1024x1024' };

describe('image adapters', () => {
  it('edits a reference image as multipart without forwarding a reference URL', async () => {
    const { client, fake } = connect(openaiCompatibleImageAdapter, { ...gateway, model: 'gpt-image-2' }, () =>
      json({ data: [{ b64_json: base64(PNG) }] }),
    );
    await client.generate({ prompt: 'make it green', reference: { data: PNG, mimeType: 'image/png' } });
    const [url, init] = fake.mock.calls[0]!;
    expect(String(url)).toBe('https://images.example.com/v1/images/edits');
    const form = init?.body as FormData;
    expect(form.get('prompt')).toBe('make it green');
    expect(form.get('image')).toBeInstanceOf(Blob);
  });

  it('asks a GPT image model for base64 without response_format and decodes the bytes', async () => {
    const openai = openaiCompatibleImageAdapter.presets!.find((preset) => preset.id === 'openai')!;
    const { client, fake } = connect(openaiCompatibleImageAdapter, openai.config, () =>
      json({ created: 1, data: [{ b64_json: base64(PNG) }], usage: { output_tokens: 196 } }),
    );
    const result = await client.generate({ prompt: 'a sprout', size: '1536x1024' });
    const { url, init, headers, body } = sent(fake);
    expect(url.href).toBe('https://api.openai.com/v1/images/generations');
    expect(init.method).toBe('POST');
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(body).toEqual({ model: 'gpt-image-2', prompt: 'a sprout', n: 1, size: '1536x1024', quality: 'low' });
    expect(result).toEqual({ images: [{ data: PNG, mimeType: 'image/png' }] });
  });

  it('asks other models for b64_json, uses the instance size and caps n', async () => {
    const { client, fake } = connect(openaiCompatibleImageAdapter, gateway, () =>
      json({ data: [{ b64_json: base64(JPEG) }, { b64_json: base64(PNG) }] }),
    );
    const result = await client.generate({ prompt: 'two leaves', n: 50 });
    expect(sent(fake).body).toEqual({
      model: 'flux-schnell',
      prompt: 'two leaves',
      n: 10,
      size: '1024x1024',
      response_format: 'b64_json',
    });
    expect(result.images.map((image) => image.mimeType)).toEqual(['image/jpeg', 'image/png']);
  });

  it('needs an explicit base URL and rejects a hosted image URL instead of fetching it', async () => {
    expect(() => openaiCompatibleImageAdapter.configSchema.parse({ model: 'gpt-image-2' })).toThrow();
    const { client, fake } = connect(openaiCompatibleImageAdapter, gateway, () =>
      json({ data: [{ url: 'https://cdn.example.net/image.png' }] }),
    );
    await expect(client.generate({ prompt: 'x' })).rejects.toThrow('returned an image URL instead of base64 data');
    expect(fake).toHaveBeenCalledOnce();
  });

  it('rejects bytes that are not an image', async () => {
    const { client } = connect(openaiCompatibleImageAdapter, gateway, () =>
      json({ data: [{ b64_json: base64(new TextEncoder().encode('{"error":"oops"}')) }] }),
    );
    await expect(client.generate({ prompt: 'x' })).rejects.toThrow('not a PNG, JPEG, WebP or GIF');
  });

  it('never follows a redirect to another origin with the key', async () => {
    const { client, fake } = connect(
      openaiCompatibleImageAdapter,
      gateway,
      () => new Response(null, { status: 308, headers: { location: 'https://collector.example.net/v1/images' } }),
    );
    await expect(client.generate({ prompt: 'x' })).rejects.toBeInstanceOf(EndpointViolation);
    expect(fake).toHaveBeenCalledOnce();
  });

  it('tests an instance with one image at its own size', async () => {
    const { client, config, fake } = connect(openaiCompatibleImageAdapter, { ...gateway, size: '512x512' }, () =>
      json({ data: [{ b64_json: base64(PNG) }] }),
    );
    await openaiCompatibleImageAdapter.test!(client, config);
    expect(sent(fake).body).toMatchObject({ n: 1, size: '512x512' });
  });
});
