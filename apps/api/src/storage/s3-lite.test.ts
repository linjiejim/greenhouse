/**
 * s3-lite tests — SigV4 correctness is pinned against two OFFICIAL vectors:
 *
 * 1. `get-vanilla` from the AWS SigV4 test suite (service "service").
 * 2. The "GET object" example from the AWS S3 SigV4 docs (service "s3",
 *    virtual-host style, extra range header).
 *
 * If the signing ever drifts, real S3/MinIO would reject every request — these
 * vectors catch that in CI without needing a live object store. The client
 * tests use an injected fetch to assert wire shape and error semantics.
 */

import { describe, it, expect } from 'vitest';
import { signV4, sha256Hex, encodeS3Key, createS3Client } from './s3-lite.js';

const EMPTY_HASH = sha256Hex('');

describe('signV4 (official AWS vectors)', () => {
  it('reproduces the aws-sig-v4-test-suite get-vanilla signature', () => {
    const { authorization, signature } = signV4({
      method: 'GET',
      path: '/',
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      payloadHash: EMPTY_HASH,
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'service',
      amzDate: '20150830T123600Z',
    });
    expect(signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('reproduces the AWS S3 docs GET-object signature (service s3)', () => {
    const { signature } = signV4({
      method: 'GET',
      path: '/test.txt',
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': EMPTY_HASH,
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: EMPTY_HASH,
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 's3',
      amzDate: '20130524T000000Z',
    });
    expect(signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
});

describe('encodeS3Key', () => {
  it('keeps / as separator and RFC3986-encodes segments', () => {
    expect(encodeS3Key('skills/pdf-report/1.0.0.json')).toBe('skills/pdf-report/1.0.0.json');
    expect(encodeS3Key('a b/c*d')).toBe('a%20b/c%2Ad');
  });
});

// ─── Client wire shape (mocked fetch) ────────────────────

interface Captured {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: Buffer;
}

function mockFetch(status: number, body = '') {
  const calls: Captured[] = [];
  const impl = (async (url: any, init?: any) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? Buffer.from(init.body) : undefined,
    });
    return new Response(body, { status });
  }) as typeof fetch;
  return { calls, impl };
}

const CFG = {
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  bucket: 'example-bucket',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
};

describe('createS3Client', () => {
  it('PUT uses path-style URL, signs content and sends the payload hash', async () => {
    const { calls, impl } = mockFetch(200);
    await createS3Client(CFG, impl).putObject('skills/pdf/1.0.0.json', '{"a":1}', 'application/json');

    const req = calls[0]!;
    expect(req.url).toBe('http://127.0.0.1:9000/example-bucket/skills/pdf/1.0.0.json');
    expect(req.method).toBe('PUT');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['x-amz-content-sha256']).toBe(sha256Hex('{"a":1}'));
    expect(req.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(req.headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(req.body?.toString()).toBe('{"a":1}');
  });

  it('virtual-host style puts the bucket in the host', async () => {
    const { calls, impl } = mockFetch(200);
    await createS3Client(
      { ...CFG, endpoint: 'https://s3.us-east-1.amazonaws.com', forcePathStyle: false },
      impl,
    ).putObject('k.json', 'x', 'application/json');
    expect(calls[0]!.url).toBe('https://example-bucket.s3.us-east-1.amazonaws.com/k.json');
  });

  it('GET returns the body, and null on 404', async () => {
    const ok = mockFetch(200, 'payload');
    expect((await createS3Client(CFG, ok.impl).getObject('k'))?.toString()).toBe('payload');

    const missing = mockFetch(404, '<Error><Code>NoSuchKey</Code></Error>');
    expect(await createS3Client(CFG, missing.impl).getObject('k')).toBeNull();
  });

  it('DELETE tolerates 404 but surfaces other failures', async () => {
    const gone = mockFetch(404);
    await expect(createS3Client(CFG, gone.impl).deleteObject('k')).resolves.toBeUndefined();

    const denied = mockFetch(403, '<Error><Code>AccessDenied</Code></Error>');
    await expect(createS3Client(CFG, denied.impl).deleteObject('k')).rejects.toThrow(/HTTP 403.*AccessDenied/s);
  });

  it('PUT failure carries status and body excerpt', async () => {
    const { impl } = mockFetch(500, '<Error>boom</Error>');
    await expect(createS3Client(CFG, impl).putObject('k', 'x', 'application/json')).rejects.toThrow(/HTTP 500.*boom/s);
  });

  it('rejects an endpoint that carries a path', () => {
    expect(() => createS3Client({ ...CFG, endpoint: 'http://127.0.0.1:9000/minio' })).toThrow(/must not carry a path/);
  });
});

describe('HEAD and ListObjectsV2', () => {
  it('HEAD returns sizes including zero, null on 404, and rejects failures or invalid lengths', async () => {
    for (const size of ['0', '125']) {
      const fetcher = (async (_url, init) => {
        expect(init?.method).toBe('HEAD');
        return new Response(null, { headers: { 'content-length': size } });
      }) as typeof fetch;
      expect(await createS3Client(CFG, fetcher).headObjectSize('file')).toBe(Number(size));
    }
    expect(await createS3Client(CFG, mockFetch(404).impl).headObjectSize('file')).toBeNull();
    await expect(createS3Client(CFG, mockFetch(403).impl).headObjectSize('file')).rejects.toThrow(/HTTP 403/);
    await expect(createS3Client(CFG, mockFetch(200).impl).headObjectSize('file')).rejects.toThrow(/Content-Length/);
  });

  it('signs canonical query strings, follows opaque tokens and decodes URL/XML keys', async () => {
    const calls: string[] = [];
    const fetcher = (async (url, init) => {
      const request = new URL(String(url));
      calls.push(request.href);
      const headers = init?.headers as Record<string, string>;
      const signed = signV4({
        method: 'GET',
        path: request.pathname,
        query: request.search.slice(1),
        headers: {
          host: request.host,
          'x-amz-date': headers['x-amz-date'],
          'x-amz-content-sha256': EMPTY_HASH,
        },
        payloadHash: EMPTY_HASH,
        accessKeyId: CFG.accessKeyId,
        secretAccessKey: CFG.secretAccessKey,
        region: CFG.region,
        service: 's3',
        amzDate: headers['x-amz-date'],
      });
      expect(headers.authorization).toBe(signed.authorization);
      return new Response(
        calls.length === 1
          ? '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>true</IsTruncated><Contents><Key>drive/中 &amp; %.txt</Key></Contents><NextContinuationToken>a+/=&amp;&#x25;</NextContinuationToken></ListBucketResult>'
          : '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>drive/a&amp;b.txt</Key></Contents></ListBucketResult>',
      );
    }) as typeof fetch;
    expect(await createS3Client(CFG, fetcher).listObjectKeys('drive/a &')).toEqual([
      'drive/中 & %.txt',
      'drive/a&b.txt',
    ]);
    expect(calls[0]).toContain('?list-type=2&max-keys=1000&prefix=drive%2Fa%20%26');
    expect(calls[1]).toContain('?continuation-token=a%2B%2F%3D%26%25&list-type=2');
  });

  it('lists an empty bucket in virtual-host style', async () => {
    const fetcher = (async (url) => {
      expect(String(url)).toContain('https://example-bucket.s3.example/?');
      return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
    }) as typeof fetch;
    expect(
      await createS3Client({ ...CFG, endpoint: 'https://s3.example', forcePathStyle: false }, fetcher).listObjectKeys(
        '',
      ),
    ).toEqual([]);
  });

  it('surfaces access errors and malformed/truncated pages instead of silently ending the sweep', async () => {
    await expect(createS3Client(CFG, mockFetch(403).impl).listObjectKeys('drive/')).rejects.toThrow(/HTTP 403/);
    for (const xml of [
      '<Error/>',
      '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>',
      '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken></ListBucketResult>',
    ]) {
      await expect(createS3Client(CFG, mockFetch(200, xml).impl).listObjectKeys('drive/')).rejects.toThrow(/S3 LIST/);
    }
  });
});

describe('presignedUrl (official AWS query-string vector)', () => {
  // "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)" — GET
  // examplebucket/test.txt, 24 h expiry, signed header host, virtual-host style.
  it('reproduces the AWS S3 docs presigned GET signature', () => {
    const client = createS3Client({
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-east-1',
      bucket: 'examplebucket',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      forcePathStyle: false,
    });
    const url = new URL(
      client.presignedUrl('GET', 'test.txt', { expiresSec: 86400, now: new Date('2013-05-24T00:00:00Z') }),
    );
    expect(url.origin).toBe('https://examplebucket.s3.amazonaws.com');
    expect(url.pathname).toBe('/test.txt');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
    expect(client.publicOrigin).toBe('https://examplebucket.s3.amazonaws.com');
  });

  it('signs response overrides into the URL and refuses unbounded expiry', () => {
    const client = createS3Client({ ...CFG });
    const url = new URL(
      client.presignedUrl('GET', 'a b.png', {
        expiresSec: 60,
        query: { 'response-content-disposition': 'inline', 'response-content-type': 'image/png' },
      }),
    );
    expect(url.origin).toBe('http://127.0.0.1:9000');
    expect(url.pathname).toBe('/example-bucket/a%20b.png');
    expect(url.searchParams.get('response-content-disposition')).toBe('inline');
    expect(() => client.presignedUrl('PUT', 'k', { expiresSec: 0 })).toThrow(/expiry/);
    expect(() => client.presignedUrl('PUT', 'k', { expiresSec: 604_801 })).toThrow(/expiry/);
  });
});

describe('streaming', () => {
  it('opens a byte range and reports the whole size', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createS3Client({ ...CFG }, (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('bcd', {
        status: 206,
        headers: { 'content-length': '3', 'content-range': 'bytes 1-3/10', 'content-type': 'video/mp4' },
      });
    }) as unknown as typeof fetch);
    const object = await client.openObject('v.mp4', { start: 1, end: 3 });
    expect(object).toMatchObject({ status: 206, contentLength: 3, size: 10, contentType: 'video/mp4' });
    expect((calls[0].init.headers as Record<string, string>).range).toBe('bytes=1-3');
    expect(await new Response((object as { body: ReadableStream }).body).text()).toBe('bcd');
  });

  it('maps 404 and 416', async () => {
    const statuses = [404, 416];
    const client = createS3Client(
      { ...CFG },
      (async () => new Response(null, { status: statuses.shift() })) as unknown as typeof fetch,
    );
    expect(await client.openObject('missing')).toBeNull();
    expect(await client.openObject('short', { start: 99 })).toBe('unsatisfiable');
  });

  it('streams a PUT with its declared length and an unsigned payload', async () => {
    let seen: RequestInit | undefined;
    const client = createS3Client({ ...CFG }, (async (_url: string, init: RequestInit) => {
      seen = init;
      await new Response(init.body as ReadableStream).arrayBuffer();
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch);
    const body = new Response('hello').body!;
    await client.putObjectStream('k.bin', body, 5, 'application/octet-stream');
    const headers = seen!.headers as Record<string, string>;
    expect(headers['content-length']).toBe('5');
    expect(headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect((seen as { duplex?: string }).duplex).toBe('half');
  });
});
