import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { corsMiddleware } from '../security/security.js';

const originalCorsOrigins = process.env.CORS_ALLOWED_ORIGINS;

function createCorsApp() {
  return new Hono().use('*', corsMiddleware).get('/api/test', (c) => c.json({ ok: true }));
}

beforeEach(() => {
  delete process.env.CORS_ALLOWED_ORIGINS;
});

afterEach(() => {
  if (originalCorsOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
  else process.env.CORS_ALLOWED_ORIGINS = originalCorsOrigins;
});

describe('corsMiddleware', () => {
  it.each(['http://localhost:8090', 'http://127.0.0.1:8090'])(
    'allows the exact Expo Web development origin %s without credentials',
    async (origin) => {
      const response = await createCorsApp().request('/api/test', {
        method: 'OPTIONS',
        headers: { Origin: origin },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    },
  );

  it.each([
    'http://localhost:8091',
    'https://localhost:8090',
    'http://127.0.0.2:8090',
    'http://localhost:8090.evil.example',
  ])('rejects a near-match Expo Web origin: %s', async (origin) => {
    const response = await createCorsApp().request('/api/test', {
      method: 'OPTIONS',
      headers: { Origin: origin },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
