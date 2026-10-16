import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalQuery, presignV4, sha256Hex, signV4 } from '../storage/sigv4.js';
import { createLocalStorage, localAdapter } from '../storage/local.js';
import { createS3Client, s3ConfigSchema } from '../storage/s3.js';

const EMPTY = sha256Hex('');

describe('SigV4 (official AWS vectors)', () => {
  it('reproduces get-vanilla from the AWS test suite', () => {
    const { signature } = signV4({
      method: 'GET',
      path: '/',
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      payloadHash: EMPTY,
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'service',
      amzDate: '20150830T123600Z',
    });
    expect(signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  it('reproduces the S3 GET-object example', () => {
    const { signature } = signV4({
      method: 'GET',
      path: '/test.txt',
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': EMPTY,
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: EMPTY,
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 's3',
      amzDate: '20130524T000000Z',
    });
    expect(signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('reproduces the S3 presigned-URL example', () => {
    const query = presignV4({
      method: 'GET',
      path: '/test.txt',
      host: 'examplebucket.s3.amazonaws.com',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 's3',
      amzDate: '20130524T000000Z',
      expiresInSeconds: 86_400,
    });
    expect(query).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });

  it('sorts and encodes query parameters', () => {
    expect(canonicalQuery({ 'list-type': '2', prefix: 'a b/c' })).toBe('list-type=2&prefix=a%20b%2Fc');
  });
});

describe('S3 client', () => {
  const config = s3ConfigSchema.parse({ endpoint: 'https://s3.example.com', bucket: 'gh', prefix: 'v2/' });
  const secrets = { accessKeyId: 'AK', secretAccessKey: 'SK' };

  it('puts and gets objects under the prefix and maps 404 to null', async () => {
    const wire = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'GET' && url.endsWith('missing')) return new Response('', { status: 404 });
      return new Response(init?.method === 'GET' ? 'hello' : '', { status: 200, headers: { 'content-length': '5' } });
    });
    const s3 = createS3Client(config, secrets, wire as unknown as typeof fetch);
    await s3.put('files/a.txt', new TextEncoder().encode('hello'), { contentType: 'text/plain' });
    expect(wire.mock.calls[0]![0]).toBe('https://s3.example.com/gh/v2/files/a.txt');
    expect(new Headers((wire.mock.calls[0]![1] as RequestInit).headers).get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256/,
    );
    const object = await s3.get('files/a.txt');
    expect(await new Response(object!.body).text()).toBe('hello');
    expect(await s3.get('missing')).toBeNull();
  });

  it('presigns GET URLs with a download name', () => {
    const s3 = createS3Client(config, secrets, fetch);
    const url = new URL(s3.presignGet!('files/a.txt', { expiresInSeconds: 600, filename: '周报.md' }));
    expect(url.pathname).toBe('/gh/v2/files/a.txt');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('response-content-disposition')).toContain("filename*=UTF-8''");
  });
});

describe('local storage', () => {
  let root = '';
  afterEach(async () => root && rm(root, { recursive: true, force: true }));

  it('stores, reads, stats and deletes objects inside its root only', async () => {
    root = await mkdtemp(join(tmpdir(), 'gh-store-'));
    const store = createLocalStorage({ root });
    await store.put('a/b.txt', new TextEncoder().encode('hi'), { contentType: 'text/plain' });
    expect(await store.head('a/b.txt')).toEqual({ size: 2 });
    expect(await new Response((await store.get('a/b.txt'))!.body).text()).toBe('hi');
    await store.delete('a/b.txt');
    expect(await store.get('a/b.txt')).toBeNull();
    await expect(store.put('../escape', new Uint8Array(), { contentType: 'x' })).rejects.toThrow('Invalid storage key');
    await expect(store.put('a//b', new Uint8Array(), { contentType: 'x' })).rejects.toThrow('Invalid storage key');
  });

  it('passes its own connection test', async () => {
    root = await mkdtemp(join(tmpdir(), 'gh-store-'));
    const config = localAdapter.configSchema.parse({ root });
    await expect(
      localAdapter.test!(localAdapter.create({ config, secrets: {}, fetch }), config),
    ).resolves.toBeUndefined();
  });
});
