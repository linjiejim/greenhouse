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
import { signV4, sha256Hex, encodeS3Key, canonicalQuery, createS3Client } from './s3-lite.js';

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

  const s3DocsBucketGet = (query: string) =>
    signV4({
      method: 'GET',
      path: '/',
      query,
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        'x-amz-content-sha256': EMPTY_HASH,
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: EMPTY_HASH,
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 's3',
      amzDate: '20130524T000000Z',
    }).signature;

  it('reproduces the AWS S3 docs signatures of requests with a query string', () => {
    // GET Bucket lifecycle (`?lifecycle`, a name without a value) and List Objects (two, sorted).
    expect(s3DocsBucketGet(canonicalQuery({ lifecycle: '' }))).toBe(
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
    expect(s3DocsBucketGet(canonicalQuery({ prefix: 'J', 'max-keys': '2' }))).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });
});

describe('canonicalQuery', () => {
  it('sorts by encoded name, encodes names and values, and keeps empty values', () => {
    expect(canonicalQuery({ uploads: '' })).toBe('uploads=');
    expect(canonicalQuery({ uploadId: 'a/b+c=', partNumber: '3' })).toBe('partNumber=3&uploadId=a%2Fb%2Bc%3D');
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

  it('streams a GET without buffering it, and answers null on 404', async () => {
    const ok = mockFetch(200, 'streamed payload');
    const stream = await createS3Client(CFG, ok.impl).getObjectStream('big/object');
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('streamed payload');
    expect(await createS3Client(CFG, mockFetch(404).impl).getObjectStream('k')).toBeNull();
  });
});

describe('multipart upload', () => {
  /** A fetch answering each multipart call as S3 does. */
  function multipartFetch(
    completeBody = '<CompleteMultipartUploadResult><ETag>"x-2"</ETag></CompleteMultipartUploadResult>',
  ) {
    const calls: Captured[] = [];
    const impl = (async (url: any, init?: any) => {
      calls.push({
        url: String(url),
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? Buffer.from(init.body) : undefined,
      });
      const { searchParams } = new URL(String(url));
      if (init?.method === 'POST' && searchParams.has('uploads')) {
        return new Response(
          '<InitiateMultipartUploadResult><UploadId>up/1+x</UploadId></InitiateMultipartUploadResult>',
        );
      }
      if (init?.method === 'PUT')
        return new Response('', { headers: { etag: `"etag-${searchParams.get('partNumber')}"` } });
      if (init?.method === 'POST') return new Response(completeBody);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    return { calls, impl };
  }

  it('starts, uploads parts, completes and aborts with signed query strings', async () => {
    const { calls, impl } = multipartFetch();
    const client = createS3Client(CFG, impl);
    const uploadId = await client.createMultipartUpload('bot-backups/u1/b1/agent', 'application/octet-stream');
    expect(uploadId).toBe('up/1+x');
    const etag = await client.uploadPart('bot-backups/u1/b1/agent', uploadId, 1, Buffer.from('part one'));
    expect(etag).toBe('"etag-1"');
    await client.completeMultipartUpload('bot-backups/u1/b1/agent', uploadId, [{ partNumber: 1, etag }]);
    await client.abortMultipartUpload('bot-backups/u1/b1/agent', uploadId);

    const base = 'http://127.0.0.1:9000/example-bucket/bot-backups/u1/b1/agent';
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${base}?uploads=`,
      `PUT ${base}?partNumber=1&uploadId=up%2F1%2Bx`,
      `POST ${base}?uploadId=up%2F1%2Bx`,
      `DELETE ${base}?uploadId=up%2F1%2Bx`,
    ]);
    expect(calls[1]!.headers['x-amz-content-sha256']).toBe(sha256Hex('part one'));
    expect(calls[2]!.body!.toString()).toBe(
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"etag-1"</ETag></Part></CompleteMultipartUpload>',
    );
    for (const call of calls) expect(call.headers['authorization']).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it('treats an <Error> body as a failure even when the status is 200', async () => {
    const { impl } = multipartFetch('<Error><Code>InternalError</Code></Error>');
    await expect(
      createS3Client(CFG, impl).completeMultipartUpload('k', 'u', [{ partNumber: 1, etag: '"e"' }]),
    ).rejects.toThrow(/InternalError/);
  });
});
