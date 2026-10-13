import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicFetch, publicLookup } from '../public-fetch.js';
import { isPrivateAddress } from '../network.js';

describe('public-only network', () => {
  const server = createServer((_, response) => response.end('internal'));
  let port = 0;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('classifies private and public addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });

  it('refuses a name that resolves only to private addresses', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      publicLookup('localhost', { all: true }, (failure) => resolve(failure)),
    );
    expect(error?.code).toBe('EPRIVATEADDRESS');
  });

  it('cannot reach a server inside the network even through a host name', async () => {
    const failure = await publicFetch(`http://localhost:${port}/`).catch(
      (error: Error & { cause?: { code?: string } }) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { cause?: { code?: string } }).cause?.code).toBe('EPRIVATEADDRESS');
  });
});
