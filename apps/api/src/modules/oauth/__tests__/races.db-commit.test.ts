/**
 * Two API processes on one database get the same code, or the same refresh token, at the same
 * moment: the row lock lets exactly one of them have it.
 */

import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { auditEvents, getDb, members, newId, oauthClients } from '@greenhouse/db';
import { createApp, createServices } from '../../../app.js';
import { loadConfig } from '../../../config/index.js';
import { REDIRECT, pkce, queryOf } from './flow.js';

const createdMembers: string[] = [];
const createdClients: string[] = [];

afterAll(async () => {
  if (createdClients.length) {
    await getDb().delete(auditEvents).where(inArray(auditEvents.clientId, createdClients));
    await getDb().delete(oauthClients).where(inArray(oauthClients.id, createdClients));
  }
  if (createdMembers.length) await getDb().delete(members).where(inArray(members.id, createdMembers));
});

function apiProcess() {
  const services = createServices(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused/test',
      TOKEN_SIGNING_KEY: 'a'.repeat(64),
      PROVIDER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
      PUBLIC_URL: 'http://greenhouse.test',
    }),
  );
  return { services, app: createApp(services) };
}

type Process = ReturnType<typeof apiProcess>;

async function tokenCall(process: Process, fields: Record<string, string>) {
  const response = await process.app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function setup() {
  const a = apiProcess();
  const b = apiProcess();
  const id = newId('member');
  createdMembers.push(id);
  await getDb()
    .insert(members)
    .values({ id, email: `${id.toLowerCase()}@example.com`, name: 'Lin', status: 'active' });
  const session = a.services.tokens.createAccessToken(id, 'member', 0);
  const registered = await a.app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Race', redirect_uris: [REDIRECT] }),
  });
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  createdClients.push(clientId);
  const { verifier, challenge } = pkce();
  const start = await a.app.request(
    `/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })}`,
  );
  const request = queryOf(start.headers.get('location')!).get('request')!;
  const decided = await b.app.request('/api/oauth/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
    body: JSON.stringify({ request, decision: 'approve' }),
  });
  const code = queryOf(((await decided.json()) as { redirect_to: string }).redirect_to).get('code')!;
  return { a, b, clientId, code, verifier };
}

describe('single use across processes', () => {
  it('hands a code to one of two simultaneous exchanges', async () => {
    const { a, b, clientId, code, verifier } = await setup();
    const fields = {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    };
    const results = await Promise.all([tokenCall(a, fields), tokenCall(b, fields)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect(results.find((result) => result.status === 400)!.body.error).toBe('invalid_grant');
    // A code presented twice is treated as stolen (RFC 6749 §4.1.2): what it gave is revoked.
    const winner = results.find((result) => result.status === 200)!;
    expect(await a.services.oauth.authenticate(winner.body.access_token)).toBeNull();
  });

  it('rotates a refresh token once, and treats the loser as reuse', async () => {
    const { a, b, clientId, code, verifier } = await setup();
    const issued = await tokenCall(a, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    const fields = { grant_type: 'refresh_token', refresh_token: issued.body.refresh_token, client_id: clientId };
    const results = await Promise.all([tokenCall(a, fields), tokenCall(b, fields)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    const winner = results.find((result) => result.status === 200)!;
    // The second presentation of a spent refresh token revoked what the first one got.
    const after = await tokenCall(b, {
      grant_type: 'refresh_token',
      refresh_token: winner.body.refresh_token,
      client_id: clientId,
    });
    expect(after.body.error).toBe('invalid_grant');
    expect(await a.services.oauth.authenticate(winner.body.access_token)).toBeNull();
  });
});
