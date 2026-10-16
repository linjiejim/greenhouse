/**
 * The vault in a turn (AGNT-21, CONV-17 login): an Agent finds the logins for the page its
 * browser shows and signs in with one. The server types the values into the page, so they never
 * reach the model, the transcript, a step, a card, the access log or a log line. `ask` logins
 * wait for the member's sign-in card; approving fills, declining tells the Agent, and handing
 * back after signing in by hand settles it too.
 */

import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentComputers,
  getDb,
  messages,
  notifications,
  requests,
  runs,
  runSteps,
  vaultAccessLog,
} from '@greenhouse/db';
import { lastUserText, scriptedModel, text, toolCall } from '../../../engine/__tests__/model.js';
import { createTestApp } from '../../../testing.js';
import { axPage, FakeChromium, type FakePage } from '../../computers/__tests__/fake-chromium.js';
import { fake, fakeSandboxEnv } from '../../computers/__tests__/fake-sandbox.js';

const USERNAME = 'lin.jie@example.com';
const PASSWORD = 'Tr0ub4dor&3-horse-staple';
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const LOGIN = 'https://login.example.com/';
const SITE = 'https://login.example.com';

const PAGES: Record<string, FakePage> = {
  [LOGIN]: {
    title: 'Sign in',
    text: 'Sign in to Example',
    ax: axPage('Sign in', [
      { role: 'textbox', name: 'Email', node: 11 },
      { role: 'textbox', name: 'Password', node: 12 },
      { role: 'button', name: 'Sign in', node: 13 },
    ]),
    fields: { username: true, password: true },
    attributes: { 12: ['type', 'password'] },
    onEnter: 'https://login.example.com/2fa',
  },
  'https://login.example.com/2fa': {
    title: 'Two-step',
    text: 'Enter the code',
    fields: { otp: 1 },
    onEnter: 'https://app.example.com/home',
  },
  'https://app.example.com/home': { title: 'Home', text: 'Welcome back' },
};

type Scripts = Parameters<typeof scriptedModel>[0];

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  process.env.LOG_LEVEL = 'debug';
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});
afterEach(() => {
  process.env.LOG_LEVEL = 'silent';
  vi.restoreAllMocks();
});

/** The model plays `scripts`, which a test fills in once it knows the login's id. */
async function setup() {
  const scripts: Scripts = [];
  const model = scriptedModel(scripts);
  const app = createTestApp(fakeSandboxEnv(), { languageModel: model.languageModel });
  const chromium = new FakeChromium(PAGES, LOGIN);
  fake.onStream = (stream) => {
    if (stream.kind === 'devtools') chromium.attach(stream);
  };
  const lin = await app.member();
  const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
  const send = async (content: string) => {
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content },
    });
    await app.services.engine.idle();
    return sent.body as { run_id: string };
  };
  const save = async (body: Record<string, unknown> = {}) =>
    (
      await app.call('POST', '/api/me/vault', {
        token: lin.token,
        body: { label: 'Example', origins: [SITE], username: USERNAME, password: PASSWORD, totp: TOTP, ...body },
      })
    ).body as { id: string };
  const stepOutputs = async (runId: string) =>
    (
      await getDb()
        .select()
        .from(runSteps)
        .where(and(eq(runSteps.runId, runId), eq(runSteps.kind, 'tool')))
        .orderBy(asc(runSteps.startedAt))
    ).map((row) => row.output as any);
  const log = async () =>
    (await getDb().select().from(vaultAccessLog).where(eq(vaultAccessLog.memberId, lin.id))).map((row) => [
      row.outcome,
      row.approval,
    ]);
  const pending = async () => (await app.call('GET', '/api/requests', { token: lin.token })).body.items[0];
  /** Everything written down about the member's turns, and what the model was shown. */
  const written = async () =>
    JSON.stringify([
      await getDb().select().from(runSteps),
      await getDb().select().from(messages),
      await getDb().select().from(requests),
      await getDb().select().from(notifications),
      await getDb().select().from(vaultAccessLog),
      await getDb().select().from(runs),
      model.prompts,
    ]);
  return { ...app, scripts, model, chromium, lin, main, send, save, stepOutputs, log, pending, written };
}

const noValues = (text: string) => {
  for (const value of [USERNAME, PASSWORD, TOTP]) expect(text).not.toContain(value);
};

describe('signing in from the vault', () => {
  it('fills an auto login itself, through a code page, and nothing it typed is written anywhere', async () => {
    const env = await setup();
    const item = await env.save({ policy: 'auto' });
    env.scripts.push(
      toolCall('vault', { action: 'find' }),
      toolCall('vault', { action: 'fill', item_id: item.id }, 'call_2'),
      text('Signed in.'),
    );
    const sent = await env.send('check my orders on example');

    expect(env.model.tools[0]).toEqual(expect.arrayContaining(['browser', 'vault']));
    const [found, filled] = await env.stepOutputs(sent.run_id);
    expect(found).toEqual({
      site: SITE,
      logins: [
        { id: item.id, label: 'Example', username_hint: 'li***@example.com', has_password: true, has_totp: true },
      ],
    });
    expect(filled).toMatchObject({ filled: ['username', 'password', 'otp'], site: SITE, submitted: true });

    // The values reached the page, and only the page.
    const [username, password, code] = env.chromium.typed;
    expect([username, password]).toEqual([USERNAME, PASSWORD]);
    expect(code).toMatch(/^\d{6}$/);
    expect(env.chromium.keys).toEqual(['Enter', 'Enter']);
    expect(env.chromium.current.url).toBe('https://app.example.com/home');

    const written = await env.written();
    noValues(written);
    expect(written).not.toContain(code);
    noValues(logged.join('\n'));
    expect(await env.log()).toEqual([['filled', 'auto']]);
    const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.run_id));
    expect(run!.status).toBe('succeeded');
  });

  it('raises a sign-in card for an ask login and fills once the member approves, even while they hold the screen', async () => {
    const env = await setup();
    const item = await env.save();
    env.scripts.push(toolCall('vault', { action: 'fill', item_id: item.id }), text('All set.'));
    const sent = await env.send('sign in to example');
    const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.run_id));
    expect(run!.status).toBe('waiting');
    expect(env.chromium.typed).toEqual([]);

    const card = await env.pending();
    expect(card).toMatchObject({
      kind: 'login',
      subject: 'vault_fill',
      status: 'pending',
      title: 'Greeny 想用「Example」登录 login.example.com',
      payload: {
        tool: 'vault',
        item_id: item.id,
        item_label: 'Example',
        site: SITE,
        username_hint: 'li***@example.com',
        submit: true,
      },
    });
    expect(await env.log()).toEqual([['requested', null]]);

    // The page the card is about stays up while it waits: an idle computer is not stopped.
    await getDb()
      .update(agentComputers)
      .set({ lastActiveAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })
      .where(eq(agentComputers.ownerId, env.lin.id));
    await env.services.computers.stopIdle();
    expect([...fake.computers.values()]).toEqual(['running']);

    // The member is at the screen when they approve: their own approval still goes ahead.
    const [computer] = await getDb().select().from(agentComputers).where(eq(agentComputers.ownerId, env.lin.id));
    expect(await env.services.computers.claimScreen(computer!.id, 'ctl_test', 'member', 60_000)).toBe('claimed');

    const approved = await env.call('POST', `/api/requests/${card.id}/approve`, { token: env.lin.token, body: {} });
    expect(approved.body.status).toBe('approved');
    await env.services.engine.idle();
    expect(env.chromium.typed.slice(0, 2)).toEqual([USERNAME, PASSWORD]);
    expect(env.chromium.current.url).toBe('https://app.example.com/home');

    const transcript = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, env.main.id))
      .orderBy(asc(messages.seq));
    expect(transcript.map((row) => [row.role, row.content])).toEqual(
      expect.arrayContaining([
        ['event', '已用「Example」登录 login.example.com'],
        ['assistant', 'All set.'],
      ]),
    );
    expect(lastUserText(env.model.prompts[1])).toContain(
      'The member approved signing in to https://login.example.com with "Example". It was filled (username, password, otp) and submitted.',
    );
    expect(await env.log()).toEqual([
      ['requested', null],
      ['filled', 'member'],
    ]);
    noValues(await env.written());
    noValues(logged.join('\n'));
    const again = await env.call('POST', `/api/requests/${card.id}/approve`, { token: env.lin.token, body: {} });
    expect(again.status).toBe(409);
  });

  it('tells the Agent when the member declines, or signs in by hand and hands the computer back', async () => {
    const env = await setup();
    const item = await env.save();
    env.scripts.push(
      toolCall('vault', { action: 'fill', item_id: item.id }),
      text('Understood.'),
      toolCall('vault', { action: 'fill', item_id: item.id }),
      text('Thanks.'),
    );

    await env.send('sign in');
    const declined = await env.call('POST', `/api/requests/${(await env.pending()).id}/reject`, {
      token: env.lin.token,
      body: { reason: 'not now' },
    });
    expect(declined.body.status).toBe('rejected');
    await env.services.engine.idle();
    expect(lastUserText(env.model.prompts[1])).toContain(
      'The member declined signing you in to https://login.example.com with "Example" and says: not now. Do not try again unless they ask.',
    );

    await env.send('sign in again');
    const handed = await env.call('POST', `/api/requests/${(await env.pending()).id}/handback`, {
      token: env.lin.token,
      body: { note: 'I typed it myself' },
    });
    expect(handed.body.status).toBe('handed_back');
    await env.services.engine.idle();
    expect(lastUserText(env.model.prompts[3])).toContain(
      'The member signed in to https://login.example.com on your computer themselves and says: I typed it myself.',
    );
    const lines = (
      await getDb().select().from(messages).where(eq(messages.conversationId, env.main.id)).orderBy(asc(messages.seq))
    )
      .filter((row) => row.role === 'event')
      .map((row) => row.content);
    expect(lines).toEqual(expect.arrayContaining(['已拒绝用「Example」登录', '已手动登录']));
    expect(env.chromium.typed).toEqual([]);
    expect(await env.log()).toEqual([
      ['requested', null],
      ['declined', null],
      ['requested', null],
    ]);
  });

  it('fills an ask login without a card on a site the member always allows', async () => {
    const env = await setup();
    const item = await env.save({ always_origins: [SITE] });
    env.scripts.push(toolCall('vault', { action: 'fill', item_id: item.id, submit: false }), text('ok'));
    await env.send('go');
    expect(env.chromium.typed).toEqual([USERNAME, PASSWORD]);
    expect(env.chromium.keys).toEqual([]);
    expect(env.chromium.value('password')).toBe(PASSWORD);
    expect(await env.pending()).toBeUndefined();
    expect(await env.log()).toEqual([['filled', 'always']]);
  });

  it('keeps a login to the Agents it names and to its own sites', async () => {
    const env = await setup();
    const scout = await env.call('POST', '/api/agents', { token: env.lin.token, body: { name: 'Scout' } });
    const scouts = await env.save({ label: 'Scout only', policy: 'auto', agent_ids: [scout.body.id] });
    const elsewhere = await env.save({ label: 'Elsewhere', policy: 'auto', origins: ['https://other.example.com'] });
    env.scripts.push(
      toolCall('vault', { action: 'find' }),
      toolCall('vault', { action: 'fill', item_id: scouts.id }, 'call_2'),
      toolCall('vault', { action: 'fill', item_id: elsewhere.id }, 'call_3'),
      text('No luck.'),
    );
    const sent = await env.send('sign in');
    const [found, limited, mismatch] = await env.stepOutputs(sent.run_id);
    expect(found.logins).toEqual([]);
    expect(found.note).toContain('no saved login');
    expect(limited).toMatchObject({ code: 'login_not_found' });
    expect(mismatch).toMatchObject({ code: 'origin_mismatch' });
    expect(env.chromium.typed).toEqual([]);
    expect(await env.log()).toEqual([['origin_mismatch', null]]);
  });

  it('does not touch the browser while the member controls the screen', async () => {
    const env = await setup();
    const item = await env.save({ policy: 'auto' });
    env.scripts.push(toolCall('vault', { action: 'fill', item_id: item.id }), text('Later.'));
    await env.services.computers.ensure(env.lin.id, 'main');
    const [computer] = await getDb().select().from(agentComputers).where(eq(agentComputers.ownerId, env.lin.id));
    await env.services.computers.claimScreen(computer!.id, 'ctl_test', 'member', 60_000);
    const sent = await env.send('sign in');
    const [refused] = await env.stepOutputs(sent.run_id);
    expect(refused).toMatchObject({ code: 'member_in_control' });
    expect(env.chromium.connections).toBe(0);
    expect(env.chromium.typed).toEqual([]);
  }, 15_000);
});
