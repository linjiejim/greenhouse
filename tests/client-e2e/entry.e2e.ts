/**
 * Entry pages of the universal client: the addresses the station sends a browser to (activation
 * mail, MCP OAuth consent, a connector's OAuth return, Feishu sign-in, account-binding returns),
 * reachable without the classic app. Activation and consent run against the real API; the
 * identity providers and the connector's provider are routed (page.route). Screenshots at
 * 1440×900, light and dark, go to .work/ports/entry/.
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { API_BASE, CLIENT_DATABASE, WEB_PORT } from '../../playwright.client.config';

const WEB = `http://localhost:${WEB_PORT}`;
const SHOTS = '.work/ports/entry';
const SIGNED_OUT = { cookies: [], origins: [] };
const CALLBACK = 'http://127.0.0.1:9/callback';

function invite(): { email: string; token: string } {
  const out = execFileSync('node_modules/.bin/tsx', ['tests/client-e2e/fixtures/entry-invite.ts'], {
    env: { ...process.env, DATABASE_URL: CLIENT_DATABASE },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

const masked = (email: string) => `${email.slice(0, 2)}***@${email.split('@')[1]}`;

async function ready(page: Page) {
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
}

/** One screenshot per appearance; `open` loads the page fresh for each (one-time links included). */
async function capture(page: Page, name: string, open: () => Promise<void>) {
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((value) => localStorage.setItem('greenhouse_pref_theme', value), theme);
    // a link that differs only in its fragment would not load the page again
    await page.goto('about:blank');
    await open();
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
  }
}

/** A real session pair for a fresh member (what a provider's code exchange answers). */
async function sessionTokens(page: Page) {
  const res = await page.request.post(`${API_BASE}/api/auth/password-link/complete`, {
    data: { token: invite().token, password: 'EntryPass123' },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { accessToken: string; refreshToken: string };
}

test.describe('signed out', () => {
  test.use({ storageState: SIGNED_OUT });

  test('an activation link sets a password and signs the new member in', async ({ page }) => {
    const account = invite();
    await page.goto(`/activate#token=${account.token}`);
    // the token is read once and leaves the address bar
    await expect(page).toHaveURL(`${WEB}/activate`);
    await expect(page.getByTestId('activate-account')).toContainText(masked(account.email));
    await page.getByTestId('activate-password').fill('EntryPass123');
    await page.getByTestId('activate-confirm').fill('EntryPass124');
    await page.getByTestId('activate-submit').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByTestId('activate-confirm').fill('EntryPass123');
    await page.getByTestId('activate-submit').click();
    await expect(page.locator('[data-testid="composer-input"]:visible').first()).toBeVisible();
    const me = await page.request.post(`${API_BASE}/api/auth/login`, {
      data: { email: account.email, password: 'EntryPass123' },
    });
    expect(me.ok()).toBeTruthy();
    // the link was single use
    await page.goto(`/activate#token=${account.token}`);
    await expect(page.getByTestId('activate-unavailable')).toBeVisible();
  });

  test('the activation page, valid and spent, in both appearances', async ({ page }) => {
    await capture(page, 'activate', async () => {
      await page.goto(`/activate#token=${invite().token}`);
      await expect(page.getByTestId('activate-password')).toBeVisible();
    });
    await capture(page, 'activate-invalid', async () => {
      await page.goto('/activate#token=not-a-token');
      await expect(page.getByTestId('activate-unavailable')).toBeVisible();
    });
  });

  test('sign-in shows Feishu only while the station offers it', async ({ page }) => {
    let providers: unknown[] = [];
    await page.route('**/api/auth/providers', (route) => route.fulfill({ json: { providers } }));
    await page.goto('/login');
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await ready(page);
    await expect(page.getByTestId('login-provider-feishu')).toHaveCount(0);
    // WeCom only binds accounts: never a sign-in button
    providers = [{ id: 'wecom', title: 'WeCom', icon: 'LogIn', login: false }];
    await page.reload();
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await expect(page.getByTestId('login-provider-wecom')).toHaveCount(0);
    providers = [{ id: 'feishu', title: 'Feishu', icon: 'LogIn', login: true }];
    await capture(page, 'login-feishu', async () => {
      await page.goto('/login');
      await expect(page.getByTestId('login-provider-feishu')).toBeVisible();
    });
  });

  test('Feishu returns a one-shot code that becomes a session', async ({ page }) => {
    const code = 'F'.repeat(43);
    const tokens = await sessionTokens(page);
    const exchanged: unknown[] = [];
    await page.route('**/api/auth/providers', (route) =>
      route.fulfill({ json: { providers: [{ id: 'feishu', title: 'Feishu', icon: 'LogIn', login: true }] } }),
    );
    await page.route('**/api/feishu/oauth/start-login', (route) =>
      route.fulfill({ json: { authorize_url: 'https://open.feishu.cn/open-apis/authen/v1/authorize?state=s' } }),
    );
    // Feishu, then the station's callback, send the browser back to /login with the code in the fragment
    await page.route('https://open.feishu.cn/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<script>location.replace(${JSON.stringify(`${WEB}/login#feishu_code=${code}`)})</script>`,
      }),
    );
    await page.route('**/api/feishu/oauth/exchange', async (route) => {
      exchanged.push(route.request().postDataJSON());
      await route.fulfill({ json: tokens });
    });
    await page.goto('/login');
    await page.getByTestId('login-provider-feishu').click();
    await expect(page.locator('[data-testid="composer-input"]:visible').first()).toBeVisible();
    expect(exchanged).toEqual([{ code }]);
    expect(page.url()).not.toContain(code);
  });

  test('a refused Feishu sign-in says why on the sign-in page', async ({ page }) => {
    await page.goto('/login#feishu=error&reason=not_bound');
    await expect(page.getByRole('alert')).toContainText(/Feishu|飞书/);
    await expect(page).toHaveURL(`${WEB}/login`);
  });
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function oauthClient(page: Page): Promise<string> {
  const res = await page.request.post(`${API_BASE}/oauth/register`, {
    data: { client_name: 'Entry Test Agent', redirect_uris: [CALLBACK] },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeUrl(clientId: string, challenge: string, state: string) {
  return `${API_BASE}/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope: 'mcp:read mcp:write mcp:files mcp:chat mcp:knowledge',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;
}

test.describe('signed in', () => {
  test('MCP consent: the station sends the browser here; Allow grants only what stays ticked', async ({ page }) => {
    const clientId = await oauthClient(page);
    const { verifier, challenge } = pkce();
    const state = `state-${randomBytes(8).toString('hex')}`;
    await page.route('http://127.0.0.1:9/**', (route) => route.fulfill({ contentType: 'text/html', body: 'ok' }));
    await capture(page, 'consent', async () => {
      await page.goto(authorizeUrl(clientId, challenge, state));
      await expect(page.getByTestId('consent-title')).toContainText('Entry Test Agent');
      await expect(page.getByTestId('consent-allow')).toBeEnabled();
    });
    await expect(page).toHaveURL(/\/oauth-consent\?/);
    await expect(page.getByTestId('consent-return')).toContainText('127.0.0.1:9');
    await expect(page.getByTestId('consent-scope-mcp:write')).toBeVisible();
    for (const group of ['files', 'chat', 'knowledge']) await expect(page.getByTestId(`consent-group-${group}`)).toBeChecked();
    await page.getByTestId('consent-group-chat').uncheck();
    await page.getByTestId('consent-allow').click();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:9\/callback\?/);
    const back = new URL(page.url());
    expect(back.searchParams.get('state')).toBe(state);
    const token = await page.request.post(`${API_BASE}/oauth/token`, {
      form: {
        grant_type: 'authorization_code',
        client_id: clientId,
        code: back.searchParams.get('code')!,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
      },
    });
    expect(token.ok()).toBeTruthy();
    const scopes = String(((await token.json()) as { scope: string }).scope).split(' ');
    expect(scopes).toEqual(expect.arrayContaining(['mcp:read', 'mcp:write', 'mcp:files', 'mcp:knowledge']));
    expect(scopes).not.toContain('mcp:chat');
  });

  test('MCP consent: Deny returns access_denied with the request’s state', async ({ page }) => {
    const clientId = await oauthClient(page);
    const state = `state-${randomBytes(8).toString('hex')}`;
    await page.route('http://127.0.0.1:9/**', (route) => route.fulfill({ contentType: 'text/html', body: 'ok' }));
    await page.goto(authorizeUrl(clientId, pkce().challenge, state));
    await page.getByTestId('consent-deny').click();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:9\/callback\?/);
    const back = new URL(page.url());
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe(state);
    expect(back.searchParams.get('code')).toBeNull();
  });

  test('a connector sign-in in the browser finishes in its popup and tells Me → Connections', async ({ page }) => {
    const connector = {
      id: 'conn_desk',
      scope: 'team',
      slug: 'desk',
      handle: 'desk',
      name: 'Desk',
      description: 'Help desk',
      auth_mode: 'per_member',
      auth_kind: 'oauth',
      status: 'not_connected',
    };
    const started: unknown[] = [];
    const finished: unknown[] = [];
    const context = page.context();
    await context.route('**/api/me/connectors', (route) =>
      route.fulfill({ json: { team: [connector], personal: [] } }),
    );
    await context.route('**/api/me/connectors/conn_desk/oauth/start', async (route) => {
      started.push(route.request().postDataJSON());
      // the provider and the station's public callback, collapsed: back to the finish page
      await route.fulfill({ json: { authorize_url: `${WEB}/connectors/oauth-finish#code=code-1&state=state-1` } });
    });
    await context.route('**/api/me/connectors/oauth/finish', async (route) => {
      finished.push(route.request().postDataJSON());
      connector.status = 'connected';
      await route.fulfill({ json: { connector_id: connector.id, connector } });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/me/connectors');
    await ready(page);
    await page.getByText('Desk', { exact: true }).click();
    const popup = page.waitForEvent('popup');
    await page.getByRole('menuitem').first().click();
    const finishPage = await popup;
    await expect(finishPage.getByTestId('connector-finish-phase')).toHaveAttribute('data-phase', 'done');
    await finishPage.waitForEvent('close');
    await expect(page.getByText(/Desk (已连接|connected)/)).toBeVisible();
    expect(started).toEqual([{ client: 'web' }]);
    expect(finished).toEqual([{ code: 'code-1', state: 'state-1' }]);
  });

  test('a connector return without a popup finishes and leads back to Connections', async ({ page }) => {
    await page.route('**/api/me/connectors/oauth/finish', (route) =>
      route.fulfill({
        json: { connector_id: 'conn_desk', connector: { id: 'conn_desk', name: 'Desk', status: 'connected' } },
      }),
    );
    await capture(page, 'connector-finish', async () => {
      await page.goto('/connectors/oauth-finish#code=code-2&state=state-2');
      await expect(page.getByTestId('connector-finish-phase')).toHaveAttribute('data-phase', 'done');
    });
    await expect(page).toHaveURL(`${WEB}/connectors/oauth-finish`);
    await capture(page, 'connector-finish-error', async () => {
      await page.goto('/connectors/oauth-finish#error=access_denied&connector_id=conn_desk');
      await expect(page.getByTestId('connector-finish-phase')).toHaveAttribute('data-phase', 'failed');
    });
    await page.getByRole('button', { name: /打开连接|Open Connections/ }).click();
    await expect(page).toHaveURL(/\/me\/connectors$/);
  });

  test('an account-binding return says how it went and where linked accounts live', async ({ page }) => {
    // Feishu is enabled and configured on this station for the member (manifest + binding answer)
    await page.route('**/api/extensions', async (route) => {
      const real = await route.fetch();
      const body = await real.json();
      await route.fulfill({
        json: { ...body, identityProviders: [{ id: 'feishu', title: 'Feishu', icon: 'LogIn', login: true, bind: true }] },
      });
    });
    await page.route('**/api/feishu/binding', (route) =>
      route.fulfill({
        json: {
          available: true,
          binding: { provider_user_id: 'ou_1', provider_name: 'Jim Lin', bound_at: '2026-10-27T08:00:00Z' },
        },
      }),
    );
    await capture(page, 'binding-ok', async () => {
      await page.goto('/bindings?feishu=ok');
      await expect(page.getByTestId('binding-result-ok')).toBeVisible();
    });
    await capture(page, 'binding-error', async () => {
      await page.goto('/bindings?wecom=error&reason=already_bound');
      await expect(page.getByTestId('binding-result-error')).toBeVisible();
    });
    await page.goto('/bindings?feishu=ok');
    await expect(page.getByTestId('binding-result-ok')).toBeVisible();
    await page.getByTestId('binding-open-connections').click();
    await expect(page).toHaveURL(/\/me\/connectors$/);
    await expect(page.getByText(/Jim Lin/)).toBeVisible();
    await capture(page, 'connections-linked', async () => {
      await page.goto('/me/connectors');
      await expect(page.getByTestId('binding-feishu')).toBeVisible();
    });
  });
});
