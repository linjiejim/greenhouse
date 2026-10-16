import { describe, expect, it } from 'vitest';
import { openaiCompatibleVideoAdapter } from '../video/adapters.js';
import { EndpointViolation } from '../pinned-fetch.js';
import { connect, json, sent } from './fake-network.js';

const config = { baseUrl: 'https://api.302.ai/openai/v1', model: 'sora-2', contentOrigins: ['https://file.302.ai'] };
const MP4 = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
describe('asynchronous video adapters', () => {
  it('submits once, reports progress, and downloads a pinned result without sending its key to the CDN', async () => {
    const { client, fake } = connect(openaiCompatibleVideoAdapter, config, (url) => {
      if (url.includes('/content')) return json({ url: 'https://file.302.ai/result.mp4' });
      if (url.includes('file.302.ai')) return new Response(MP4, { headers: { 'content-type': 'video/mp4' } });
      if (url.endsWith('/videos/v1')) return json({ id: 'v1', status: 'in_progress', progress: 30 });
      return json({ id: 'v1', status: 'queued', progress: 0 });
    });
    expect(await client.create({ prompt: 'a sprout', seconds: 4 })).toMatchObject({ id: 'v1', status: 'queued' });
    expect(sent(fake).body).toMatchObject({ model: 'sora-2', seconds: 4 });
    expect(await client.retrieve('v1')).toMatchObject({ progress: 30 });
    expect((await client.content('v1')).data).toEqual(MP4);
    expect(sent(fake, 3).headers.has('authorization')).toBe(false);
  });
  it('refuses an unconfigured content host', async () => {
    const { client } = connect(openaiCompatibleVideoAdapter, config, () => json({ url: 'https://evil.example/video' }));
    await expect(client.content('v1')).rejects.toBeInstanceOf(EndpointViolation);
  });
  it('rejects a non-video body and caps a large response before reading it', async () => {
    const { client } = connect(
      openaiCompatibleVideoAdapter,
      config,
      () => new Response('not a video', { headers: { 'content-type': 'video/mp4', 'content-length': '100000000' } }),
    );
    await expect(client.content('v1')).rejects.toThrow('50 MB');
  });
});
