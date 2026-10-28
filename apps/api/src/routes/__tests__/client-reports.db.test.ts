/**
 * Client error reports against real PostgreSQL, behind the real bearer check and role guards
 * mounted as in src/index.ts: members send batches (stored redacted and cut, resends stored once,
 * non-reports dropped, size and per-member rate capped); only a super reads the grouped view.
 */

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { ClientErrorReport, ClientReport } from '@greenhouse/types/client-reports';

process.env.TOKEN_SIGNING_KEY ??= '44'.repeat(32);

import type { AppEnv } from '../../app-env.js';
import { authMiddleware, requireInternal, requireSuper } from '../../auth/middleware.js';
import { createAccessToken } from '../../auth/token.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { CLIENT_REPORT_RATE, adminClientReportRoutes, clientReportRoutes } from '../client-reports.js';

let db: DatabaseProvider;
let member: UserRow;
let other: UserRow;
let admin: UserRow;

const tag = () => randomBytes(5).toString('hex');

function app() {
  return new Hono<AppEnv>()
    .use('*', authMiddleware)
    .use('/api/admin/*', requireSuper())
    .route('/api/admin/client-reports', adminClientReportRoutes)
    .use('/api/client-reports', requireInternal())
    .route('/api/client-reports', clientReportRoutes);
}

function bearer(user: UserRow): Record<string, string> {
  return { Authorization: `Bearer ${createAccessToken(user.id, user.role as 'team' | 'super', user.auth_version)}` };
}

function report(overrides: Partial<ClientReport> = {}): ClientReport {
  return {
    id: `r_${tag()}`,
    occurred_at: new Date().toISOString(),
    fatal: false,
    source: 'global',
    name: 'TypeError',
    message: `Cannot read property 'id' of undefined (${tag()})`,
    stack: 'TypeError: boom\n    at open (index.bundle:1:200)',
    route: '/sheet/doc',
    platform: 'ios',
    os_version: '26.1',
    app_version: '4.0.0',
    app_build: '41',
    api_level: 4,
    ...overrides,
  };
}

async function send(as: UserRow | null, body: unknown) {
  const res = await app().request('/api/client-reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(as ? bearer(as) : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function stored(user: UserRow) {
  return db.executeRaw(
    sql`SELECT * FROM client_reports WHERE user_id = ${user.id} ORDER BY client_report_id`,
  ) as Promise<Record<string, any>[]>;
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  member = await createInternalTestUser(db, { email: `reports_member_${tag()}@test.local` });
  other = await createInternalTestUser(db, { email: `reports_other_${tag()}@test.local` });
  admin = await createInternalTestUser(db, { email: `reports_admin_${tag()}@test.local`, role: 'super' });
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

describe('POST /api/client-reports', () => {
  it('needs a signed-in member', async () => {
    expect((await send(null, { reports: [report()] })).status).toBe(401);
  });

  it('stores a batch, redacted again on the station, and a resend once', async () => {
    const leaky = report({
      message:
        'Request to https://station.test/api/drive?token=abc failed for jim@test.local: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      stack: `Error\n    at fetch (https://station.test/app.js?v=1#frag)\n    at parse ("${'hello this is the text of my private document'}")`,
      route: '/sheet/doc?id=doc_01JABCDEFGHJKMNPQRSTVWXYZ0#title',
    });
    const plain = report({ fatal: true, source: 'promise' });
    const first = await send(member, { reports: [leaky, plain] });
    expect(first).toEqual({ status: 202, json: { stored: 2, duplicates: 0, rejected: 0 } });

    const rows = await stored(member);
    expect(rows).toHaveLength(2);
    const row = rows.find((r) => r.client_report_id === leaky.id)!;
    expect(row.message).toBe('Request to https://station.test/api/drive failed for [email]: Bearer [redacted]');
    expect(row.stack).not.toContain('private document');
    expect(row.stack).not.toContain('?v=1');
    expect(row.route).toBe('/sheet/doc');
    expect(row.platform).toBe('ios');
    expect(row.api_level).toBe(4);
    expect(rows.find((r) => r.client_report_id === plain.id)).toMatchObject({ fatal: true, source: 'promise' });

    // the answer was lost and the phone sends the same batch again: nothing new is stored
    const again = await send(member, { reports: [leaky, plain] });
    expect(again.json).toEqual({ stored: 0, duplicates: 2, rejected: 0 });
    expect(await stored(member)).toHaveLength(2);
    // ids are per member: another member's phone may use the same one
    expect((await send(other, { reports: [plain] })).json).toEqual({ stored: 1, duplicates: 0, rejected: 0 });
  });

  it('cuts long text and drops entries that are not reports, keeping the rest', async () => {
    const long = report({
      message: 'x '.repeat(2000),
      stack: Array.from({ length: 200 }, (_, i) => `at f${i} (a.js:1:${i})`).join('\n'),
    });
    const result = await send(member, {
      reports: [long, { ...report(), id: 'no' }, { ...report(), platform: 'symbian' }, 'boom'],
    });
    expect(result).toEqual({ status: 202, json: { stored: 1, duplicates: 0, rejected: 3 } });
    const [row] = await stored(member);
    expect(row.message.length).toBeLessThanOrEqual(600);
    expect(row.stack.split('\n').length).toBeLessThanOrEqual(40);
  });

  it('refuses empty, oversized and over-long batches', async () => {
    expect((await send(member, { reports: [] })).status).toBe(400);
    expect((await send(member, 'not json')).status).toBe(400);
    expect((await send(member, { reports: Array.from({ length: 21 }, () => report()) })).status).toBe(400);
    const huge = await send(member, { reports: [report({ message: 'y'.repeat(70 * 1024) })] });
    expect(huge.status).toBe(413);
    expect(await stored(member)).toHaveLength(0);
  });

  it('rate-limits each member on their own', async () => {
    for (let i = 0; i < CLIENT_REPORT_RATE.max; i++) {
      expect((await send(member, { reports: [report()] })).status).toBe(202);
    }
    const limited = await send(member, { reports: [report()] });
    expect(limited.status).toBe(429);
    expect(await stored(member)).toHaveLength(CLIENT_REPORT_RATE.max);
    // someone else's phone is not held back
    expect((await send(other, { reports: [report()] })).status).toBe(202);
  });
});

describe('GET /api/admin/client-reports', () => {
  async function read(as: UserRow, days = '30') {
    const res = await app().request(`/api/admin/client-reports?days=${days}`, { headers: bearer(as) });
    return { status: res.status, json: (await res.json()) as ClientErrorReport };
  }

  it('is super only', async () => {
    expect((await read(member)).status).toBe(403);
    expect((await read(admin, '12')).status).toBe(400);
  });

  it('groups reports by name and normalized message with counts, members, platforms and versions', async () => {
    const message = `Worklet threw in frame ${tag()}`;
    const earlier = new Date(Date.now() - 3_600_000).toISOString();
    await send(member, {
      reports: [
        report({ message: `${message} 12`, occurred_at: earlier, app_version: '4.0.0', platform: 'ios' }),
        report({ message: `${message} 13`, fatal: true, app_version: '4.0.1', platform: 'ios', route: '/doc-new' }),
      ],
    });
    await send(other, { reports: [report({ message: `${message} 14`, occurred_at: earlier, platform: 'web' })] });

    const { status, json } = await read(admin);
    expect(status).toBe(200);
    expect(json.days).toBe(30);
    expect(json.total).toBeGreaterThanOrEqual(3);
    const group = json.groups.find((g) => g.message.startsWith(message));
    expect(group).toMatchObject({
      name: 'TypeError',
      message: `${message} 13`,
      fatal: true,
      count: 3,
      members: 2,
      platforms: ['ios', 'web'],
      versions: ['4.0.1', '4.0.0'],
      latest: { route: '/doc-new', platform: 'ios', app_version: '4.0.1', api_level: 4 },
    });
    expect(Date.parse(group!.first_at)).toBeLessThan(Date.parse(group!.last_at));
    expect(group!.last_at).toMatch(/Z$/);
  });
});
