/** AWS Signature V4, header and query (presign) forms. Pure, pinned by official vectors. */

import { createHash, createHmac } from 'node:crypto';

export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** An object key for the canonical URI, keeping `/` as the separator. */
export function encodeKey(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

export function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

export const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

export interface SignInput {
  method: string;
  /** Already encoded, starting with '/'. */
  path: string;
  query?: string;
  /** Must include host (and x-amz-date for header auth). */
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  amzDate: string;
}

function canonical(input: SignInput) {
  const entries = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const signedHeaders = entries.map(([k]) => k).join(';');
  const request = [
    input.method,
    input.path,
    input.query ?? '',
    entries.map(([k, v]) => `${k}:${v}\n`).join(''),
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  return { request, signedHeaders };
}

function signature(input: SignInput, canonicalRequest: string): { signature: string; scope: string } {
  const date = input.amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), input.service), 'aws4_request');
  return { signature: createHmac('sha256', key).update(toSign).digest('hex'), scope };
}

export function signV4(input: SignInput): { authorization: string; signature: string } {
  const { request, signedHeaders } = canonical(input);
  const { signature: sig, scope } = signature(input, request);
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    signature: sig,
  };
}

/** Query-string auth (a presigned URL) for a GET signed on the host header only. */
export function presignV4(
  input: Omit<SignInput, 'headers' | 'payloadHash' | 'query'> & {
    host: string;
    expiresInSeconds: number;
    extraQuery?: Record<string, string>;
  },
): string {
  const date = input.amzDate.slice(0, 8);
  const params: Record<string, string> = {
    ...input.extraQuery,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.accessKeyId}/${date}/${input.region}/${input.service}/aws4_request`,
    'X-Amz-Date': input.amzDate,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const query = canonicalQuery(params);
  const signing: SignInput = { ...input, query, headers: { host: input.host }, payloadHash: 'UNSIGNED-PAYLOAD' };
  const { signature: sig } = signature(signing, canonical(signing).request);
  return `${query}&X-Amz-Signature=${sig}`;
}

export function amzDate(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}
