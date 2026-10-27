import { afterEach, describe, expect, it } from 'vitest';
import oauthRoutes from '../oauth.js';

const query =
  'response_type=code&client_id=c1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcb&state=state-12345678' +
  '&code_challenge=Ab_-Cd&code_challenge_method=S256&scope=mcp%3Aread+mcp%3Afiles&resource=https%3A%2F%2Fx%2Fapi%2Fmcp';

describe('GET /oauth/authorize', () => {
  const saved = process.env.WEB_BASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.WEB_BASE_URL;
    else process.env.WEB_BASE_URL = saved;
  });

  it('sends the browser to the client consent page with the request unchanged', async () => {
    process.env.WEB_BASE_URL = 'https://greenhouse.example.test';
    const res = await oauthRoutes.request(`https://greenhouse.example.test/oauth/authorize?${query}`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://greenhouse.example.test/oauth-consent');
    expect([...location.searchParams]).toEqual([...new URLSearchParams(query)]);
    expect(location.searchParams.has('oauth_authorize')).toBe(false);
    expect(location.hash).toBe('');
  });
});
