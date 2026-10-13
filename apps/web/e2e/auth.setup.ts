import { mkdirSync, writeFileSync } from 'node:fs';
import { test as setup, expect } from '@playwright/test';
import { E2E, PEOPLE } from './env';

/**
 * Signs each person in once through the API and saves the session the web keeps in
 * localStorage, so tests start signed in without spending the sign-in rate limit.
 */
setup('sign everyone in', async ({ request }) => {
  mkdirSync(new URL('.auth', import.meta.url), { recursive: true });
  const origin = `http://127.0.0.1:${E2E.webPort}`;
  for (const [key, person] of Object.entries(PEOPLE)) {
    const response = await request.post(`${origin}/api/auth/login`, {
      data: { email: person.email, password: person.password, client: 'web' },
    });
    expect(response.ok()).toBe(true);
    const state = {
      cookies: [],
      origins: [
        { origin, localStorage: [{ name: 'greenhouse.session', value: JSON.stringify(await response.json()) }] },
      ],
    };
    writeFileSync(new URL(`.auth/${key}.json`, import.meta.url), JSON.stringify(state));
  }
});
